// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// This program is useful for including in Sandstorm application packages where
// the application itself is a legacy HTTP web server that does not understand
// how to speak the Cap'n Proto interface directly.  This program will start up
// that server and then redirect incoming requests to it over standard HTTP on
// the loopback network interface.

#include <kj/main.h>
#include <kj/debug.h>
#include <kj/async-io.h>
#include <kj/async-unix.h>
#include <kj/io.h>
#include <capnp/rpc-twoparty.h>
#include <capnp/rpc.capnp.h>
#include <capnp/schema.h>
#include <capnp/serialize.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <map>
#include <unordered_map>
#include <time.h>
#include <stdlib.h>
#include <signal.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <fcntl.h>
#include <stdio.h>

#include <sandstorm/util.capnp.h>
#include <sandstorm/grain.capnp.h>
#include <sandstorm/api-session.capnp.h>
#include <sandstorm/web-session.capnp.h>
#include <sandstorm/email.capnp.h>
#include <sandstorm/sandstorm-http-bridge.capnp.h>
#include <sandstorm/hack-session.capnp.h>
#include <sandstorm/package.capnp.h>
#include <joyent-http/http_parser.h>

#include "version.h"
#include "util.h"

namespace sandstorm {

kj::String percentEncode(kj::StringPtr text) {
  const char HEX_DIGITS[] = "0123456789abcdef";
  kj::Vector<char> result;
  for (char c: text) {
    if (('A' <= c && c <= 'Z') || ('a' <= c && c <= 'z') || ('0' <= c && c <= '9') ||
        c == '-' || c == '_' || c == '.' || c == '~') {
      result.add(c);
    } else {
      byte b = c;
      result.add('%');
      result.add(HEX_DIGITS[b/16]);
      result.add(HEX_DIGITS[b%16]);
    }
  }
  return kj::heapString(result.begin(), result.size());
}

kj::Array<byte> toBytes(kj::StringPtr text, kj::ArrayPtr<const byte> data = nullptr) {
  auto result = kj::heapArray<byte>(text.size() + data.size());
  memcpy(result.begin(), text.begin(), text.size());
  memcpy(result.begin() + text.size(), data.begin(), data.size());
  return result;
}

struct HttpStatusInfo {
  WebSession::Response::Which type;

  union {
    WebSession::Response::SuccessCode successCode;
    struct { bool shouldResetForm; } noContent;
    struct { bool isPermanent; bool switchToGet; } redirect;
    WebSession::Response::ClientErrorCode clientErrorCode;
  };
};

HttpStatusInfo noContentInfo(bool shouldResetForm) {
  HttpStatusInfo result;
  result.type = WebSession::Response::NO_CONTENT;
  result.noContent.shouldResetForm = shouldResetForm;
  return result;
}

HttpStatusInfo redirectInfo(bool isPermanent, bool switchToGet) {
  HttpStatusInfo result;
  result.type = WebSession::Response::REDIRECT;
  result.redirect.isPermanent = isPermanent;
  result.redirect.switchToGet = switchToGet;
  return result;
}

HttpStatusInfo preconditionFailedInfo() {
  HttpStatusInfo result;
  result.type = WebSession::Response::PRECONDITION_FAILED;
  return result;
}

HttpStatusDescriptor::Reader getHttpStatusAnnotation(capnp::EnumSchema::Enumerant enumerant) {
  for (auto annotation: enumerant.getProto().getAnnotations()) {
    if (annotation.getId() == HTTP_STATUS_ANNOTATION_ID) {
      return annotation.getValue().getStruct().getAs<HttpStatusDescriptor>();
    }
  }
  KJ_FAIL_ASSERT("Missing httpStatus annotation on status code enumerant.",
                 enumerant.getProto().getName());
}

std::unordered_map<uint, HttpStatusInfo> makeStatusCodes() {
  std::unordered_map<uint, HttpStatusInfo> result;
  for (capnp::EnumSchema::Enumerant enumerant:
       capnp::Schema::from<WebSession::Response::SuccessCode>().getEnumerants()) {
    auto& info = result[getHttpStatusAnnotation(enumerant).getId()];
    info.type = WebSession::Response::CONTENT;
    info.successCode = static_cast<WebSession::Response::SuccessCode>(enumerant.getOrdinal());
  }
  for (capnp::EnumSchema::Enumerant enumerant:
       capnp::Schema::from<WebSession::Response::ClientErrorCode>().getEnumerants()) {
    auto& info = result[getHttpStatusAnnotation(enumerant).getId()];
    info.type = WebSession::Response::CLIENT_ERROR;
    info.clientErrorCode =
        static_cast<WebSession::Response::ClientErrorCode>(enumerant.getOrdinal());
  }

  result[204] = noContentInfo(false);
  result[205] = noContentInfo(true);

  result[304] = preconditionFailedInfo();

  result[301] = redirectInfo(true, true);
  result[302] = redirectInfo(false, true);
  result[303] = redirectInfo(false, true);
  result[307] = redirectInfo(false, false);
  result[308] = redirectInfo(true, false);

  result[412] = preconditionFailedInfo();

  return result;
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wglobal-constructors"
const std::unordered_map<uint, HttpStatusInfo> HTTP_STATUS_CODES = makeStatusCodes();
#pragma clang diagnostic pop

class HttpParser: public sandstorm::Handle::Server,
                  private http_parser,
                  private kj::TaskSet::ErrorHandler {
public:
  HttpParser(sandstorm::ByteStream::Client responseStream)
    : responseStream(responseStream),
      taskSet(*this) {
    memset(&settings, 0, sizeof(settings));
    settings.on_status = &on_status;
    settings.on_header_field = &on_header_field;
    settings.on_header_value = &on_header_value;
    settings.on_body = &on_body;
    settings.on_headers_complete = &on_headers_complete;
    settings.on_message_complete = &on_message_complete;
    http_parser_init(this, HTTP_RESPONSE);
  }

  kj::Promise<kj::ArrayPtr<byte>> readResponse(kj::AsyncIoStream& stream) {
    // Read from the stream until we have enough data to forward the response. If the response
    // is streaming or an upgrade, then just read the headers; otherwise read the entire stream.
    // If the response is an upgrade, return any remainder bytes that should be forwarded to the
    // new web socket; otherwise return an empty array.

    return stream.tryRead(buffer, 1, sizeof(buffer)).then(
        [this, &stream](size_t actual) mutable -> kj::Promise<kj::ArrayPtr<byte>> {
      size_t nread = http_parser_execute(this, &settings, reinterpret_cast<char*>(buffer), actual);
      if (nread != actual && !upgrade) {
        const char* error = http_errno_description(HTTP_PARSER_ERRNO(this));
        KJ_FAIL_ASSERT("Failed to parse HTTP response from sandboxed app.", error);
      } else if (upgrade) {
        KJ_ASSERT(nread <= actual && nread >= 0);
        return kj::arrayPtr(buffer + nread, actual - nread);
      } else if (messageComplete || actual == 0) {
        // The parser is done or the stream has closed.
        KJ_ASSERT(headersComplete, "HTTP response from sandboxed app had incomplete headers.");
        return kj::arrayPtr(buffer, 0);
      } else if (headersComplete && status_code / 100 == 2) {
        isStreaming = true;
        return kj::arrayPtr(buffer,0);
      } else {
        return readResponse(stream);
      }
    });
  }

  void pumpStream(kj::Own<kj::AsyncIoStream>&& stream) {
    if (isStreaming) {
      if (body.size() > 0) {
        auto request = responseStream.writeRequest();
        auto dst = request.initData(body.size());
        memcpy(dst.begin(), body.begin(), body.size());
        taskSet.add(request.send().ignoreResult());
        body.resize(0);
      }

      taskSet.add(pumpStreamInternal(kj::mv(stream)));
    }
  }

  void build(WebSession::Response::Builder builder, sandstorm::Handle::Client handle) {
    KJ_ASSERT(!upgrade,
        "Sandboxed app attempted to upgrade protocol when client did not request this.");

    auto iter = HTTP_STATUS_CODES.find(status_code);
    HttpStatusInfo statusInfo;
    if (iter != HTTP_STATUS_CODES.end()) {
      statusInfo = iter->second;
    } else if (status_code / 100 == 4) {
      statusInfo.type = WebSession::Response::CLIENT_ERROR;
      statusInfo.clientErrorCode = WebSession::Response::ClientErrorCode::BAD_REQUEST;
    } else if (status_code / 100 == 5) {
      statusInfo.type = WebSession::Response::SERVER_ERROR;
    } else {
      KJ_FAIL_REQUIRE(
          "Application used unsupported HTTP status code.  Status codes must be whitelisted "
          "because some have sandbox-breaking effects.", (uint)status_code, statusString);
    }

    auto cookieList = builder.initSetCookies(cookies.size());
    for (size_t i: kj::indices(cookies)) {
      auto cookie = cookieList[i];
      cookie.setName(cookies[i].name);
      cookie.setValue(cookies[i].value);
      if (cookies[i].path != nullptr) {
        cookie.setPath(cookies[i].path);
      }
      switch (cookies[i].expirationType) {
        case Cookie::ExpirationType::NONE:
          cookie.getExpires().setNone();
          break;
        case Cookie::ExpirationType::ABSOLUTE:
          cookie.getExpires().setAbsolute(cookies[i].expires);
          break;
        case Cookie::ExpirationType::RELATIVE:
          cookie.getExpires().setRelative(cookies[i].expires);
          break;
      }
      cookie.setHttpOnly(cookies[i].httpOnly);
    }

    switch (statusInfo.type) {
      case WebSession::Response::CONTENT: {
        auto content = builder.initContent();
        content.setStatusCode(statusInfo.successCode);

        KJ_IF_MAYBE(encoding, findHeader("content-encoding")) {
          content.setEncoding(*encoding);
        }
        KJ_IF_MAYBE(language, findHeader("content-language")) {
          content.setLanguage(*language);
        }
        KJ_IF_MAYBE(mimeType, findHeader("content-type")) {
          content.setMimeType(*mimeType);
        }
        KJ_IF_MAYBE(etag, findHeader("etag")) {
          parseETag(*etag, content.initETag());
        }
        KJ_IF_MAYBE(disposition, findHeader("content-disposition")) {
          // Parse `attachment; filename="foo"`
          // TODO(cleanup):  This is awful.  Use KJ parser library?
          auto parts = split(*disposition, ';');
          if (parts.size() > 1 && trim(parts[0]) == "attachment") {
            // Starst with "attachment;".  Parse params.
            for (auto& part: parts.asPtr().slice(1, parts.size())) {
              // Parse a "name=value" parameter.
              for (size_t i: kj::indices(part)) {
                if (part[i] == '=') {
                  // Found '='.  Split and interpret.
                  if (trim(part.slice(0, i)) == "filename") {
                    // It's "filename=", the one we're looking for!
                    // We need to unquote/unescape the file name.
                    auto filename = trimArray(part.slice(i + 1, part.size()));

                    if (filename.size() >= 2 && filename[0] == '\"' &&
                        filename[filename.size() - 1] == '\"') {
                      // OK, it is in fact surrounded in quotes.  Unescape the contents.  The
                      // escaping scheme defined in RFC 822 is very simple:  a backslash followed
                      // by any character C is interpreted as simply C.
                      filename = filename.slice(1, filename.size() - 1);

                      kj::Vector<char> unescaped(filename.size() + 1);
                      for (size_t j = 0; j < filename.size(); j++) {
                        if (filename[j] == '\\') {
                          if (++j >= filename.size()) {
                            break;
                          }
                        }
                        unescaped.add(filename[j]);
                      }
                      unescaped.add('\0');

                      content.getDisposition().setDownload(
                          kj::StringPtr(unescaped.begin(), unescaped.size() - 1));
                    } else {
                      // Buggy app failed to quote filename, but we'll try to deal.
                      content.getDisposition().setDownload(kj::str(filename));
                    }
                  }
                  break;  // Only split at first '='.
                }
              }
            }
          }
        }

        if (isStreaming) {
          KJ_ASSERT(body.size() == 0);
          content.initBody().setStream(handle);
        } else {
          auto data = content.initBody().initBytes(body.size());
          memcpy(data.begin(), body.begin(), body.size());
        }
        break;
      }
      case WebSession::Response::NO_CONTENT: {
        auto noContent = builder.initNoContent();
        noContent.setShouldResetForm(statusInfo.noContent.shouldResetForm);
        break;
      }
      case WebSession::Response::PRECONDITION_FAILED: {
        auto preconditionFailed = builder.initPreconditionFailed();
        KJ_IF_MAYBE(etag, findHeader("etag")) {
          parseETag(*etag, preconditionFailed.initMatchingETag());
        }
        break;
      }
      case WebSession::Response::REDIRECT: {
        auto redirect = builder.initRedirect();
        redirect.setIsPermanent(statusInfo.redirect.isPermanent);
        redirect.setSwitchToGet(statusInfo.redirect.switchToGet);
        redirect.setLocation(KJ_ASSERT_NONNULL(findHeader("location"),
            "Application returned redirect response missing Location header.", (int)status_code));
        break;
      }
      case WebSession::Response::CLIENT_ERROR: {
        auto error = builder.initClientError();
        error.setStatusCode(statusInfo.clientErrorCode);
        auto text = error.initDescriptionHtml(body.size());
        memcpy(text.begin(), body.begin(), body.size());
        break;
      }
      case WebSession::Response::SERVER_ERROR: {
        auto text = builder.initServerError().initDescriptionHtml(body.size());
        memcpy(text.begin(), body.begin(), body.size());
        break;
      }
    }
  }

  void buildForWebSocket(WebSession::OpenWebSocketResults::Builder builder) {
    // TODO(soon):  If the app returned a normal response without upgrading, we should forward that
    //   through, as it's perfectly valid HTTP.  The WebSession interface currently does not
    //   support this.
    KJ_ASSERT(status_code == 101, "Sandboxed app does not support WebSocket.",
              (int)upgrade, (int)status_code, statusString);

    KJ_IF_MAYBE(protocol, findHeader("sec-websocket-protocol")) {
      auto parts = split(*protocol, ',');
      auto list = builder.initProtocol(parts.size());
      for (auto i: kj::indices(parts)) {
        auto trimmed = trim(parts[i]);
        memcpy(list.init(i, trimmed.size()).begin(), trimmed.begin(), trimmed.size());
      }
    }

    // TODO(soon):  Should we do more validation here, like checking the exact value of the Upgrade
    //   header or Sec-WebSocket-Accept?
  }

  void buildOptions(WebSession::Options::Builder builder) {
    KJ_ASSERT(!upgrade,
        "Sandboxed app attempted to upgrade protocol when client did not request this.");

    KJ_IF_MAYBE(dav, findHeader("dav")) {
      kj::Vector<kj::String> extensions;
      for (auto level: split(*dav, ',')) {
        auto trimmed = trim(level);
        if (trimmed == "1") {
          builder.setDavClass1(true);
        } else if (trimmed == "2") {
          builder.setDavClass2(true);
        } else if (trimmed == "3") {
          builder.setDavClass3(true);
        } else {
          extensions.add(kj::mv(trimmed));
        }
      }
      if (extensions.size() > 0) {
        auto list = builder.initDavExtensions(extensions.size());
        for (auto i: kj::indices(extensions)) {
          list.set(i, extensions[i]);
        }
      }
    }
  }

private:
  enum HeaderElementType { NONE, FIELD, VALUE };

  struct RawHeader {
    kj::Vector<char> name;
    kj::Vector<char> value;
  };

  struct Header {
    kj::String name;
    kj::String value;
  };

  struct Cookie {
    kj::String name;
    kj::String value;
    kj::String path;
    int64_t expires;

    enum ExpirationType {
      NONE, RELATIVE, ABSOLUTE
    };
    ExpirationType expirationType = NONE;

    bool httpOnly = false;
  };

  sandstorm::ByteStream::Client responseStream;
  kj::TaskSet taskSet;
  bool headersComplete = false;
  bool messageComplete = false;
  byte buffer[4096];
  http_parser_settings settings;
  kj::Vector<RawHeader> rawHeaders;
  kj::Vector<char> rawStatusString;
  HeaderElementType lastHeaderElement = NONE;
  std::map<kj::StringPtr, Header> headers;
  kj::Vector<char> body;
  kj::Vector<Cookie> cookies;
  kj::String statusString;
  bool isStreaming = false;

  kj::Promise<void> pumpStreamInternal(kj::Own<kj::AsyncIoStream>&& stream) {
    return stream->tryRead(buffer, 1, sizeof(buffer)).then(
        [this, KJ_MVCAP(stream)](size_t actual) mutable -> kj::Promise<void> {
      size_t nread = http_parser_execute(this, &settings, reinterpret_cast<char*>(buffer), actual);
      if (nread != actual) {
        const char* error = http_errno_description(HTTP_PARSER_ERRNO(this));
        KJ_FAIL_ASSERT("Failed to parse HTTP response from sandboxed app.", error);
      } else if (messageComplete || actual == 0) {
        // The parser is done or the stream has closed.
        taskSet.add(responseStream.doneRequest().send().ignoreResult());
        return kj::READY_NOW;
      } else {
        taskSet.add(pumpStreamInternal(kj::mv(stream)));
        return kj::READY_NOW;
      }
    });
  }

  void taskFailed(kj::Exception&& exception) override {
    KJ_LOG(ERROR, exception);
  }

  kj::Maybe<kj::StringPtr> findHeader(kj::StringPtr name) {
    auto iter = headers.find(name);
    if (iter == headers.end()) {
      return nullptr;
    } else {
      return kj::StringPtr(iter->second.value);
    }
  }

  void onStatus(kj::ArrayPtr<const char> status) {
    rawStatusString.addAll(status);
  }

  void onHeaderField(kj::ArrayPtr<const char> name) {
    if (lastHeaderElement != FIELD) {
      rawHeaders.resize(rawHeaders.size() + 1);
    }
    rawHeaders[rawHeaders.size() - 1].name.addAll(name);
    lastHeaderElement = FIELD;
  }

  void onHeaderValue(kj::ArrayPtr<const char> value) {
    rawHeaders[rawHeaders.size() - 1].value.addAll(value);
    lastHeaderElement = VALUE;
  }

  void addHeader(RawHeader &rawHeader) {
    auto name = kj::heapString(rawHeader.name);
    toLower(name);
    kj::ArrayPtr<const char> value = rawHeader.value.asPtr();

    if (name == "set-cookie") {
      // Really ugly cookie-parsing code.
      // TODO(cleanup):  Clean up.
      bool isFirst = true;
      Cookie cookie;
      for (auto part: split(value, ';')) {
        if (isFirst) {
          isFirst = false;
          cookie.name = trim(KJ_ASSERT_NONNULL(splitFirst(part, '='),
              "Invalid cookie header from app.", value));
          cookie.value = trim(part);
        } else KJ_IF_MAYBE(name, splitFirst(part, '=')) {
          auto prop = trim(*name);
          toLower(prop);
          if (prop == "expires") {
            auto value = trim(part);
            // Wed, 15 Nov 1995 06:25:24 GMT
            struct tm t;
            memset(&t, 0, sizeof(t));

            // There are three allowed formats for HTTP dates.  Ugh.
            char* end = strptime(value.cStr(), "%a, %d %b %Y %T GMT", &t);
            if (end == nullptr) {
              end = strptime(value.cStr(), "%a, %d-%b-%y %T GMT", &t);
              if (end == nullptr) {
                end = strptime(value.cStr(), "%a %b %d %T %Y", &t);
                if (end == nullptr) {
                  // Not valid per HTTP spec, but MediaWiki seems to return this format sometimes.
                  end = strptime(value.cStr(), "%a, %d-%b-%Y %T GMT", &t);
                  if (end == nullptr) {
                    // Not valid per HTTP spec, but used by Rack.
                    end = strptime(value.cStr(), "%a, %d %b %Y %T -0000", &t);
                  }
                }
              }
            }
            KJ_ASSERT(end != nullptr && *end == '\0', "Invalid HTTP date from app.", value);
            cookie.expires = timegm(&t);
            cookie.expirationType = Cookie::ExpirationType::ABSOLUTE;
          } else if (prop == "max-age") {
            auto value = trim(part);
            char* end;
            cookie.expires = strtoull(value.cStr(), &end, 10);
            KJ_ASSERT(end > value.begin() && *end == '\0', "Invalid cookie max-age app.", value);
            cookie.expirationType = Cookie::ExpirationType::RELATIVE;
          } else if (prop == "path") {
            cookie.path = trim(part);
          } else {
            // Ignore other properties:
            //   Path:  Not useful on the modern same-origin-policy web.
            //   Domain:  We do not allow the app to publish cookies visible to other hosts in the
            //     domain.
          }
        } else {
          auto prop = trim(part);
          toLower(prop);
          if (prop == "httponly") {
            cookie.httpOnly = true;
          } else {
            // Ignore other properties:
            //   Secure:  We always set this, since we always require https.
          }
        }
      }

      cookies.add(kj::mv(cookie));

    } else {
      auto& slot = headers[name];
      if (slot.name != nullptr) {
        // Multiple instances of the same header are equivalent to comma-delimited.
        slot.value = kj::str(kj::mv(slot.value), ", ", value);
      } else {
        slot = Header { kj::mv(name), kj::heapString(value) };
      }
    }
  }


  void onBody(kj::ArrayPtr<const char> data) {
    if (isStreaming) {
      // TODO(soon): Pause the input whenever too many write requests are in-flight at once.
      //   Otherwise, a large file download may end up entirely buffered in RAM.
      // TODO(security): Cap'n Proto itself should stop processing inbound messages when too many
      //   requests are in-flight, measured by the size of the requests. Otherwise the queuing
      //   described above will actually happen at the front-end and not even be charged to the
      //   user. Watch out for deadlock, though.
      auto request = responseStream.writeRequest();
      auto dst = request.initData(data.size());
      memcpy(dst.begin(), data.begin(), data.size());
      taskSet.add(request.send().ignoreResult());
    } else {
      body.addAll(data);
    }
  }

  void onHeadersComplete() {
    for (auto &rawHeader : rawHeaders) {
      addHeader(rawHeader);
    }

    statusString = kj::heapString(rawStatusString);

    headersComplete = true;
    KJ_ASSERT(status_code >= 100, (int)status_code);
  }

  void onMessageComplete() {
    messageComplete = true;
  }

#define ON_DATA(lower, title) \
  static int on_##lower(http_parser* p, const char* d, size_t s) { \
    static_cast<HttpParser*>(p)->on##title(kj::arrayPtr(d, s)); \
    return 0; \
  }
#define ON_EVENT(lower, title) \
  static int on_##lower(http_parser* p) { \
    static_cast<HttpParser*>(p)->on##title(); \
    return 0; \
  }

  ON_DATA(status, Status)
  ON_DATA(header_field, HeaderField)
  ON_DATA(header_value, HeaderValue)
  ON_DATA(body, Body)
  ON_EVENT(headers_complete, HeadersComplete)
  ON_EVENT(message_complete, MessageComplete)
#undef ON_DATA
#undef ON_EVENT

  static void parseETag(kj::StringPtr input, WebSession::ETag::Builder builder) {
    auto trimmed = trim(input);
    input = trimmed;
    if (input.startsWith("W/")) {
      input = input.slice(2);
      builder.setWeak(true);
    }

    KJ_REQUIRE(input.startsWith("\"") && input.endsWith("\"") && input.size() > 1,
               "app returned invalid ETag header", input);

    bool escaped = false;
    kj::Vector<char> result(input.size() - 2);
    for (char c: input.slice(1, input.size() - 1)) {
      if (escaped) {
        escaped = false;
      } else {
        KJ_REQUIRE(c != '"', "app returned invalid ETag header", input);
        if (c == '\\') {
          escaped = true;
          continue;
        }
      }
      result.add(c);
    }

    memcpy(builder.initValue(result.size()).begin(), result.begin(), result.size());
  }
};

class WebSocketPump final: public WebSession::WebSocketStream::Server,
                           private kj::TaskSet::ErrorHandler {
public:
  WebSocketPump(kj::Own<kj::AsyncIoStream> serverStream,
                WebSession::WebSocketStream::Client clientStream)
      : serverStream(kj::mv(serverStream)),
        clientStream(kj::mv(clientStream)),
        upstreamOp(kj::READY_NOW),
        tasks(*this) {}

  void pump() {
    // Repeatedly read from serverStream and write to clientStream.
    tasks.add(serverStream->tryRead(buffer, 1, sizeof(buffer))
        .then([this](size_t amount) {
      if (amount > 0) {
        sendData(kj::arrayPtr(buffer, amount));
        pump();
      } else {
        // EOF.
        clientStream = nullptr;
      }
    }));
  }

  void sendData(kj::ArrayPtr<byte> data) {
    // Write the given bytes to clientStream.
    auto request = clientStream.sendBytesRequest(
        capnp::MessageSize { data.size() / sizeof(capnp::word) + 8, 0 });
    request.setMessage(data);
    tasks.add(request.send().ignoreResult());
  }

protected:
  kj::Promise<void> sendBytes(SendBytesContext context) override {
    // Received bytes from the client.  Write them to serverStream.
    auto forked = upstreamOp.then([context,this]() mutable {
      auto message = context.getParams().getMessage();
      return serverStream->write(message.begin(), message.size());
    }).fork();
    upstreamOp = forked.addBranch();
    return forked.addBranch();
  }

private:
  kj::Own<kj::AsyncIoStream> serverStream;
  WebSession::WebSocketStream::Client clientStream;

  kj::Promise<void> upstreamOp;
  // The promise working on writing data to serverStream.  AsyncIoStream wants only one write() at
  // a time, so new writes have to wait for the previous write to finish.

  kj::TaskSet tasks;
  // Pending calls to clientStream.sendBytes() and serverStream.read().

  byte buffer[4096];

  void taskFailed(kj::Exception&& exception) override {
    // TODO(soon):  What do we do when a server -> client send throws?  Probably just ignore it;
    //   WebSocket datagrams are intended to be one-way and thus the application protocol on top of
    //   them needs to implement acks at a higher level.  If the client has disconnected, we expect
    //   the whole pump will be destroyed shortly anyway.
    KJ_LOG(ERROR, exception);
  }
};

class RefcountedAsyncIoStream: public kj::AsyncIoStream, public kj::Refcounted {
public:
  RefcountedAsyncIoStream(kj::Own<kj::AsyncIoStream>&& stream)
      : stream(kj::mv(stream)) {}

  kj::Promise<size_t> read(void* buffer, size_t minBytes, size_t maxBytes) override {
    return stream->read(buffer, minBytes, maxBytes);
  }
  kj::Promise<size_t> tryRead(void* buffer, size_t minBytes, size_t maxBytes) override {
    return stream->tryRead(buffer, minBytes, maxBytes);
  }
  kj::Promise<void> write(const void* buffer, size_t size) override {
    return stream->write(buffer, size);
  }
  kj::Promise<void> write(kj::ArrayPtr<const kj::ArrayPtr<const byte>> pieces) override {
    return stream->write(pieces);
  }
  void shutdownWrite() override {
    return stream->shutdownWrite();
  }

private:
  kj::Own<kj::AsyncIoStream> stream;
};

class RequestStreamImpl final: public WebSession::RequestStream::Server {
public:
  RequestStreamImpl(kj::String httpRequest,
                    kj::Own<kj::AsyncIoStream> stream,
                    sandstorm::ByteStream::Client responseStream)
      : stream(kj::refcounted<RefcountedAsyncIoStream>(kj::mv(stream))),
        responseStream(responseStream),
        httpRequest(kj::mv(httpRequest)) {}

  kj::Promise<void> getResponse(GetResponseContext context) override {
    KJ_REQUIRE(!getResponseCalled, "getResponse() called more than once");
    getResponseCalled = true;

    // Remember that this is expected to be called *before* done() is called, so that the
    // application can start sending back data before it has received the entire request if it so
    // desires.

    auto parser = kj::heap<HttpParser>(responseStream);
    auto results = context.getResults();

    return parser->readResponse(*stream).then(
        [this, results, KJ_MVCAP(parser)]
        (kj::ArrayPtr<byte> remainder) mutable {
      KJ_ASSERT(remainder.size() == 0);
      parser->pumpStream(kj::addRef(*stream));
      auto &parserRef = *parser;
      sandstorm::Handle::Client handle = kj::mv(parser);
      parserRef.build(results, handle);
    });
  }

  kj::Promise<void> write(WriteContext context) override {
    KJ_REQUIRE(!doneCalled, "write() called after done()");
    writeHeadersOnce(nullptr);

    auto data = context.getParams().getData();
    bytesReceived += data.size();
    KJ_IF_MAYBE(s, expectedSize) {
      KJ_REQUIRE(bytesReceived <= *s, "received more bytes than expected");
    }

    // Forward the data.
    auto promise = previousWrite.then([this, data]() {
      if (isChunked) {
        kj::String chunkSize = kj::str(kj::hex(data.size()), "\r\n");
        kj::ArrayPtr<char> buffer = chunkSize.asArray();
        return stream->write(buffer.begin(), buffer.size())
            .attach(kj::mv(chunkSize))
            .then([this, data] () {
          return stream->write(data.begin(), data.size()).then([this] () {
            return stream->write("\r\n", 2);
          });
        });
      } else {
        return stream->write(data.begin(), data.size());
      }
    });
    auto fork = promise.fork();
    previousWrite = fork.addBranch();
    return fork.addBranch();
  }

  kj::Promise<void> done(DoneContext context) override {
    KJ_IF_MAYBE(s, expectedSize) {
      KJ_REQUIRE(bytesReceived == *s,
          "done() called before all bytes expected via expectedSize() were written");
    }
    KJ_REQUIRE(!doneCalled, "done() called twice");
    doneCalled = true;

    // If we haven't written headers yet, then the content is empty, so we can pass zero for the
    // expected size. (If we have written headers then the size we pass will be ignored.)
    writeHeadersOnce(kj::implicitCast<uint64_t>(0));

    if (isChunked) {
      previousWrite = previousWrite.then([this]() {
        return stream->write("0\r\n\r\n", 5);
      });
    }

    auto fork = previousWrite.fork();
    previousWrite = fork.addBranch();
    return fork.addBranch();
  }

  kj::Promise<void> expectSize(ExpectSizeContext context) override {
    uint64_t size = context.getParams().getSize();
    expectedSize = bytesReceived + size;
    writeHeadersOnce(size);
    return kj::READY_NOW;
  }

private:
  kj::Own<RefcountedAsyncIoStream> stream;
  sandstorm::ByteStream::Client responseStream;
  bool doneCalled = false;
  bool getResponseCalled = false;
  bool isChunked = true; // chunked unless we get expectSize() before we write the headers
  uint64_t bytesReceived = 0;
  kj::Maybe<uint64_t> expectedSize;
  kj::Promise<void> previousWrite = nullptr;  // initialized in writeHeadersOnce()
  kj::Maybe<kj::String> httpRequest;

  void writeHeadersOnce(kj::Maybe<uint64_t> contentLength) {
    KJ_IF_MAYBE(r, httpRequest) {
      // We haven't sent the request yet.
      kj::String reqString = kj::mv(*r);
      httpRequest = nullptr;

      // Hackily splice in content-length or transfer-encoding header.
      KJ_ASSERT(reqString.endsWith("\r\n\r\n"));
      KJ_IF_MAYBE(l, contentLength) {
        isChunked = false;
        reqString = kj::str(
            reqString.slice(0, reqString.size() - 2),
            "Content-Length: ", *l, "\r\n"
            "\r\n");
      } else {
        reqString = kj::str(
            reqString.slice(0, reqString.size() - 2),
            "Transfer-Encoding: chunked\r\n"
            "\r\n");
      }

      auto bytes = toBytes(reqString);
      kj::ArrayPtr<const byte> bytesRef = bytes;
      previousWrite = stream->write(bytesRef.begin(), bytesRef.size()).attach(kj::mv(bytes));
    }
  }
};

typedef std::map<kj::StringPtr, SessionContext::Client&> SessionContextMap;
// A UiView gives each of its sessions an ID string that serves as a SessionContextMap key
// and is sent to the app in the X-Sandstorm-Session-Id header. Each session is responsible for
// maintaining its entry in the map. The map is used to implement a SandstormHttpBridge
// capability.

class WebSessionImpl final: public WebSession::Server {
public:
  WebSessionImpl(kj::NetworkAddress& serverAddr,
                 UserInfo::Reader userInfo, SessionContext::Client sessionContext,
                 SessionContextMap& sessionContextMap, kj::String&& sessionId, kj::String&& tabId,
                 kj::String&& basePath, kj::String&& userAgent, kj::String&& acceptLanguages,
                 kj::String&& rootPath, kj::String&& permissions, kj::Maybe<kj::String> remoteAddress)
      : serverAddr(serverAddr),
        sessionContext(kj::mv(sessionContext)),
        sessionContextMap(sessionContextMap),
        sessionId(kj::mv(sessionId)),
        tabId(kj::mv(tabId)),
        userDisplayName(percentEncode(userInfo.getDisplayName().getDefaultText())),
        userHandle(kj::heapString(userInfo.getPreferredHandle())),
        userPicture(kj::heapString(userInfo.getPictureUrl())),
        userPronouns(userInfo.getPronouns()),
        permissions(kj::mv(permissions)),
        basePath(kj::mv(basePath)),
        userAgent(kj::mv(userAgent)),
        acceptLanguages(kj::mv(acceptLanguages)),
        rootPath(kj::mv(rootPath)),
        remoteAddress(kj::mv(remoteAddress)) {
    if (userInfo.hasIdentityId()) {
      auto id = userInfo.getIdentityId();
      KJ_ASSERT(id.size() == 32, "Identity ID not a SHA-256?");

      // We truncate to 128 bits to be a little more wieldy. Still 32 chars, though.
      userId = hexEncode(userInfo.getIdentityId().slice(0, 16));
    }
    sessionContextMap.insert({kj::StringPtr(this->sessionId), this->sessionContext});
  }

  ~WebSessionImpl() {
    sessionContextMap.erase(kj::StringPtr(sessionId));
  }

  kj::Promise<void> get(GetContext context) override {
    GetParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders(
        params.getIgnoreBody() ? "HEAD" : "GET", params.getPath(), params.getContext());
    return sendRequest(toBytes(httpRequest), context);
  }

  kj::Promise<void> post(PostContext context) override {
    PostParams::Reader params = context.getParams();
    auto content = params.getContent();
    kj::String httpRequest = makeHeaders("POST", params.getPath(), params.getContext(),
      kj::str("Content-Type: ", content.getMimeType()),
      kj::str("Content-Length: ", content.getContent().size()),
      content.hasEncoding() ? kj::str("Content-Encoding: ", content.getEncoding()) : nullptr);
    return sendRequest(toBytes(httpRequest, content.getContent()), context);
  }

  kj::Promise<void> put(PutContext context) override {
    PutParams::Reader params = context.getParams();
    auto content = params.getContent();
    kj::String httpRequest = makeHeaders("PUT", params.getPath(), params.getContext(),
      kj::str("Content-Type: ", content.getMimeType()),
      kj::str("Content-Length: ", content.getContent().size()),
      content.hasEncoding() ? kj::str("Content-Encoding: ", content.getEncoding()) : nullptr);
    return sendRequest(toBytes(httpRequest, content.getContent()), context);
  }

  kj::Promise<void> patch(PatchContext context) override {
    PatchParams::Reader params = context.getParams();
    auto content = params.getContent();
    kj::String httpRequest = makeHeaders("PATCH", params.getPath(), params.getContext(),
      kj::str("Content-Type: ", content.getMimeType()),
      kj::str("Content-Length: ", content.getContent().size()),
      content.hasEncoding() ? kj::str("Content-Encoding: ", content.getEncoding()) : nullptr);
    return sendRequest(toBytes(httpRequest, content.getContent()), context);
  }

  kj::Promise<void> delete_(DeleteContext context) override {
    DeleteParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders("DELETE", params.getPath(), params.getContext());
    return sendRequest(toBytes(httpRequest), context);
  }

  kj::Promise<void> propfind(PropfindContext context) override {
    PropfindParams::Reader params = context.getParams();

    const char* depth = "infinity";
    switch (params.getDepth()) {
      case WebSession::PropfindDepth::INFINITY_: depth = "infinity"; break;
      case WebSession::PropfindDepth::ZERO:      depth = "0"; break;
      case WebSession::PropfindDepth::ONE:       depth = "1"; break;
    }

    auto xml = params.getXmlContent();
    kj::String httpRequest = makeHeaders(
        "PROPFIND", params.getPath(), params.getContext(),
        kj::str("Content-Type: application/xml;charset=utf-8"),
        kj::str("Content-Length: ", xml.size()),
        kj::str("Depth: ", depth));
    return sendRequest(toBytes(httpRequest, xml.asBytes()), context);
  }

  kj::Promise<void> proppatch(ProppatchContext context) override {
    ProppatchParams::Reader params = context.getParams();
    auto xml = params.getXmlContent();
    kj::String httpRequest = makeHeaders(
        "PROPPATCH", params.getPath(), params.getContext(),
        kj::str("Content-Type: application/xml;charset=utf-8"),
        kj::str("Content-Length: ", xml.size()));
    return sendRequest(toBytes(httpRequest, xml.asBytes()), context);
  }

  kj::Promise<void> mkcol(MkcolContext context) override {
    MkcolParams::Reader params = context.getParams();
    auto content = params.getContent();
    kj::String httpRequest = makeHeaders(
        "MKCOL", params.getPath(), params.getContext(),
        kj::str("Content-Type: ", content.getMimeType()),
        kj::str("Content-Length: ", content.getContent().size()),
        content.hasEncoding() ? kj::str("Content-Encoding: ", content.getEncoding()) : nullptr);
    return sendRequest(toBytes(httpRequest, content.getContent()), context);
  }

  kj::Promise<void> copy(CopyContext context) override {
    CopyParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders(
        "COPY", params.getPath(), params.getContext(),
        makeDestinationHeader(params.getDestination()),
        makeOverwriteHeader(params.getNoOverwrite()),
        makeDepthHeader(params.getShallow()));
    return sendRequest(toBytes(httpRequest), context);
  }

  kj::Promise<void> move(MoveContext context) override {
    MoveParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders(
        "MOVE", params.getPath(), params.getContext(),
        makeDestinationHeader(params.getDestination()),
        makeOverwriteHeader(params.getNoOverwrite()));
    return sendRequest(toBytes(httpRequest), context);
  }

  kj::Promise<void> lock(LockContext context) override {
    LockParams::Reader params = context.getParams();
    auto xml = params.getXmlContent();
    kj::String httpRequest = makeHeaders(
        "LOCK", params.getPath(), params.getContext(),
        kj::str("Content-Type: application/xml;charset=utf-8"),
        kj::str("Content-Length: ", xml.size()),
        makeDepthHeader(params.getShallow()));
    return sendRequest(toBytes(httpRequest, xml.asBytes()), context);
  }

  kj::Promise<void> unlock(UnlockContext context) override {
    UnlockParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders(
        "UNLOCK", params.getPath(), params.getContext(),
        kj::str("Lock-Token: ", params.getLockToken()));
    return sendRequest(toBytes(httpRequest, nullptr), context);
  }

  kj::Promise<void> acl(AclContext context) override {
    AclParams::Reader params = context.getParams();
    auto xml = params.getXmlContent();
    kj::String httpRequest = makeHeaders(
        "ACL", params.getPath(), params.getContext(),
        kj::str("Content-Type: application/xml;charset=utf-8"),
        kj::str("Content-Length: ", xml.size()));
    return sendRequest(toBytes(httpRequest, xml.asBytes()), context);
  }

  kj::Promise<void> report(ReportContext context) override {
    ReportParams::Reader params = context.getParams();
    auto content = params.getContent();
    kj::String httpRequest = makeHeaders(
        "REPORT", params.getPath(), params.getContext(),
        kj::str("Content-Type: ", content.getMimeType()),
        kj::str("Content-Length: ", content.getContent().size()),
        content.hasEncoding() ? kj::str("Content-Encoding: ", content.getEncoding()) : nullptr);
    return sendRequest(toBytes(httpRequest, content.getContent()), context);
  }

  kj::Promise<void> options(OptionsContext context) override {
    OptionsParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders("OPTIONS", params.getPath(), params.getContext());
    return sendOptionsRequest(kj::mv(httpRequest), context);
  }

  kj::Promise<void> postStreaming(PostStreamingContext context) override {
    PostStreamingParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders("POST", params.getPath(), params.getContext(),
        kj::str("Content-Type: ", params.getMimeType()),
        params.hasEncoding() ? kj::str("Content-Encoding: ", params.getEncoding()) : nullptr);
    return sendRequestStreaming(kj::mv(httpRequest), context);
  }

  kj::Promise<void> putStreaming(PutStreamingContext context) override {
    PutStreamingParams::Reader params = context.getParams();
    kj::String httpRequest = makeHeaders("PUT", params.getPath(), params.getContext(),
        kj::str("Content-Type: ", params.getMimeType()),
        params.hasEncoding() ? kj::str("Content-Encoding: ", params.getEncoding()) : nullptr);
    return sendRequestStreaming(kj::mv(httpRequest), context);
  }

  kj::Promise<void> openWebSocket(OpenWebSocketContext context) override {
    // TODO(soon):  Use actual random Sec-WebSocket-Key?  Unclear if this has any importance when
    //   not trying to work around broken proxies.

    auto params = context.getParams();

    kj::Vector<kj::String> lines(16);

    lines.add(kj::str("GET ", rootPath, params.getPath(), " HTTP/1.1"));
    lines.add(kj::str("Upgrade: websocket"));
    lines.add(kj::str("Connection: Upgrade"));
    lines.add(kj::str("Sec-WebSocket-Key: mj9i153gxeYNlGDoKdoXOQ=="));
    auto protocols = params.getProtocol();
    if (protocols.size() > 0) {
      lines.add(kj::str("Sec-WebSocket-Protocol: ", kj::strArray(params.getProtocol(), ", ")));
    }
    lines.add(kj::str("Sec-WebSocket-Version: 13"));

    addCommonHeaders(lines, params.getContext());

    auto httpRequest = toBytes(kj::strArray(lines, "\r\n"));
    WebSession::WebSocketStream::Client clientStream = params.getClientStream();
    sandstorm::ByteStream::Client responseStream =
        context.getParams().getContext().getResponseStream();
    context.releaseParams();

    return serverAddr.connect().then(
        [this, KJ_MVCAP(httpRequest), KJ_MVCAP(clientStream), responseStream, context]
        (kj::Own<kj::AsyncIoStream>&& stream) mutable {
      kj::ArrayPtr<const byte> httpRequestRef = httpRequest;
      auto& streamRef = *stream;
      return streamRef.write(httpRequestRef.begin(), httpRequestRef.size())
          .attach(kj::mv(httpRequest))
          .then([KJ_MVCAP(stream), KJ_MVCAP(clientStream), responseStream, context]
                () mutable {
            auto parser = kj::heap<HttpParser>(responseStream);
            auto results = context.getResults();

            return parser->readResponse(*stream).then(
                [results, KJ_MVCAP(stream), KJ_MVCAP(clientStream), KJ_MVCAP(parser)]
                (kj::ArrayPtr<byte> remainder) mutable {
              auto pump = kj::heap<WebSocketPump>(kj::mv(stream), kj::mv(clientStream));
              parser->buildForWebSocket(results);
              if (remainder.size() > 0) {
                pump->sendData(remainder);
              }
              pump->pump();
              results.setServerStream(kj::mv(pump));
            });
          });
    });
  }

private:
  kj::NetworkAddress& serverAddr;
  SessionContext::Client sessionContext;
  SessionContextMap& sessionContextMap;
  kj::String sessionId;
  kj::String tabId;
  kj::String userDisplayName;
  kj::String userHandle;
  kj::String userPicture;
  UserInfo::Pronouns userPronouns = UserInfo::Pronouns::NEUTRAL;
  kj::Maybe<kj::String> userId;
  kj::String permissions;
  kj::String basePath;
  kj::String userAgent;
  kj::String acceptLanguages;
  kj::String rootPath;
  spk::BridgeConfig::Reader config;
  kj::Maybe<kj::String> remoteAddress;

  kj::String makeHeaders(kj::StringPtr method, kj::StringPtr path,
                         WebSession::Context::Reader context,
                         kj::String extraHeader1 = nullptr,
                         kj::String extraHeader2 = nullptr,
                         kj::String extraHeader3 = nullptr) {
    kj::Vector<kj::String> lines(16);

    lines.add(kj::str(method, " ", rootPath, path, " HTTP/1.1"));
    lines.add(kj::str("Connection: close"));
    if (extraHeader1 != nullptr) {
      lines.add(kj::mv(extraHeader1));
    }
    if (extraHeader2 != nullptr) {
      lines.add(kj::mv(extraHeader2));
    }
    if (extraHeader3 != nullptr) {
      lines.add(kj::mv(extraHeader3));
    }
    lines.add(kj::str("Accept-Encoding: gzip"));
    if (acceptLanguages.size() > 0) {
      lines.add(kj::str("Accept-Language: ", acceptLanguages));
    }

    addCommonHeaders(lines, context);

    return kj::strArray(lines, "\r\n");
  }

  void addCommonHeaders(kj::Vector<kj::String>& lines, WebSession::Context::Reader context) {
    if (userAgent.size() > 0) {
      lines.add(kj::str("User-Agent: ", userAgent));
    }
    lines.add(kj::str("X-Sandstorm-Tab-Id: ", tabId));
    lines.add(kj::str("X-Sandstorm-Username: ", userDisplayName));
    KJ_IF_MAYBE(u, userId) {
      lines.add(kj::str("X-Sandstorm-User-Id: ", *u));

      // Since the user is logged in, also include their other info.
      if (userHandle.size() > 0) {
        lines.add(kj::str("X-Sandstorm-Preferred-Handle: ", userHandle));
      }
      if (userPicture.size() > 0) {
        lines.add(kj::str("X-Sandstorm-User-Picture: ", userPicture));
      }
      capnp::EnumSchema schema = capnp::Schema::from<UserInfo::Pronouns>();
      uint pronounValue = static_cast<uint>(userPronouns);
      auto enumerants = schema.getEnumerants();
      if (pronounValue > 0 && pronounValue < enumerants.size()) {
        lines.add(kj::str("X-Sandstorm-User-Pronouns: ",
            enumerants[pronounValue].getProto().getName()));
      }
    }
    lines.add(kj::str("X-Sandstorm-Permissions: ", permissions));
    if (basePath.size() > 0) {
      lines.add(kj::str("X-Sandstorm-Base-Path: ", basePath));
      lines.add(kj::str("Host: ", extractHostFromUrl(basePath)));
      lines.add(kj::str("X-Forwarded-Proto: ", extractProtocolFromUrl(basePath)));
    } else {
      // Dummy value. Some API servers (e.g. git-http-backend) fail if Host is not present.
      lines.add(kj::str("Host: sandbox"));
    }
    lines.add(kj::str("X-Sandstorm-Session-Id: ", sessionId));
    KJ_IF_MAYBE(addr, remoteAddress) {
      lines.add(kj::str("X-Real-IP: ", *addr));
    }

    auto cookies = context.getCookies();
    if (cookies.size() > 0) {
      lines.add(kj::str("Cookie: ", kj::strArray(
            KJ_MAP(c, cookies) {
              return kj::str(c.getKey(), "=", c.getValue());
            }, "; ")));
    }
    auto acceptList = context.getAccept();
    if (acceptList.size() > 0) {
      lines.add(kj::str("Accept: ", kj::strArray(
            KJ_MAP(c, acceptList) {
              if (c.getQValue() == 1.0) {
                return kj::str(c.getMimeType());
              } else {
                return kj::str(c.getMimeType(), "; q=", c.getQValue());
              }
            }, ", ")));
    } else {
      lines.add(kj::str("Accept: */*"));
    }
    auto additionalHeaderList = context.getAdditionalHeaders();
    if (additionalHeaderList.size() > 0) {
      for (auto header : additionalHeaderList) {
        lines.add(kj::str(header.getName(), ": ", header.getValue()));
      }
    }
    auto eTagPrecondition = context.getETagPrecondition();
    switch (eTagPrecondition.which()) {
      case WebSession::Context::ETagPrecondition::NONE:
        break;
      case WebSession::Context::ETagPrecondition::EXISTS:
        lines.add(kj::str("If-Match: *"));
        break;
      case WebSession::Context::ETagPrecondition::DOESNT_EXIST:
        lines.add(kj::str("If-None-Match: *"));
        break;
      case WebSession::Context::ETagPrecondition::MATCHES_ONE_OF:
        lines.add(kj::str("If-Match: ", kj::strArray(
              KJ_MAP(e, eTagPrecondition.getMatchesOneOf()) {
                if (e.getWeak()) {
                  return kj::str("W/\"", e.getValue(), '"');
                } else {
                  return kj::str('"', e.getValue(), '"');
                }
              }, ", ")));
        break;
      case WebSession::Context::ETagPrecondition::MATCHES_NONE_OF:
        lines.add(kj::str("If-None-Match: ", kj::strArray(
              KJ_MAP(e, eTagPrecondition.getMatchesNoneOf()) {
                if (e.getWeak()) {
                  return kj::str("W/\"", e.getValue(), '"');
                } else {
                  return kj::str('"', e.getValue(), '"');
                }
              }, ", ")));
        break;
    }

    lines.add(kj::str(""));
    lines.add(kj::str(""));
  }

  template <typename Context>
  kj::Promise<void> sendRequest(kj::Array<byte> httpRequest, Context& context) {
    sandstorm::ByteStream::Client responseStream =
        context.getParams().getContext().getResponseStream();
    context.releaseParams();
    return serverAddr.connect().then(
        [KJ_MVCAP(httpRequest), responseStream, context]
        (kj::Own<kj::AsyncIoStream>&& stream) mutable {
      kj::ArrayPtr<const byte> httpRequestRef = httpRequest;
      auto& streamRef = *stream;
      return streamRef.write(httpRequestRef.begin(), httpRequestRef.size())
          .attach(kj::mv(httpRequest))
          .then([KJ_MVCAP(stream), responseStream, context]() mutable {
        // Note:  Do not do stream->shutdownWrite() as some HTTP servers will decide to close the
        // socket immediately on EOF, even if they have not actually responded to previous requests
        // yet.
        auto parser = kj::heap<HttpParser>(responseStream);
        auto results = context.getResults();

        return parser->readResponse(*stream).then(
            [results, KJ_MVCAP(stream), KJ_MVCAP(parser)]
            (kj::ArrayPtr<byte> remainder) mutable {
          KJ_ASSERT(remainder.size() == 0);
          parser->pumpStream(kj::mv(stream));
          auto &parserRef = *parser;
          sandstorm::Handle::Client handle = kj::mv(parser);
          parserRef.build(results, handle);
        });
      });
    });
  }

  template <typename Context>
  kj::Promise<void> sendRequestStreaming(kj::String httpRequest, Context& context) {
    sandstorm::ByteStream::Client responseStream =
      context.getParams().getContext().getResponseStream();
    context.releaseParams();
    return serverAddr.connect().then(
        [KJ_MVCAP(httpRequest), responseStream, context]
        (kj::Own<kj::AsyncIoStream>&& stream) mutable {
      auto requestStream = kj::heap<RequestStreamImpl>(
          kj::mv(httpRequest), kj::mv(stream), responseStream);
      context.getResults().setStream(kj::mv(requestStream));
    });
  }

  kj::Promise<void> sendOptionsRequest(kj::String httpRequest, OptionsContext& context) {
    context.releaseParams();
    return serverAddr.connect().then(
        [KJ_MVCAP(httpRequest), context]
        (kj::Own<kj::AsyncIoStream>&& stream) mutable {
      kj::StringPtr httpRequestRef = httpRequest;
      auto& streamRef = *stream;
      return streamRef.write(httpRequestRef.begin(), httpRequestRef.size())
          .attach(kj::mv(httpRequest))
          .then([KJ_MVCAP(stream), context]() mutable {
        // Note:  Do not do stream->shutdownWrite() as some HTTP servers will decide to close the
        // socket immediately on EOF, even if they have not actually responded to previous requests
        // yet.
        auto parser = kj::heap<HttpParser>(kj::heap<IgnoreStream>());

        return parser->readResponse(*stream).then(
            [context, KJ_MVCAP(stream), KJ_MVCAP(parser)]
            (kj::ArrayPtr<byte> remainder) mutable {
          KJ_ASSERT(remainder.size() == 0);
          parser->pumpStream(kj::mv(stream));
          auto &parserRef = *parser;
          parserRef.buildOptions(context.getResults());
        });
      });
    });
  }

  class IgnoreStream: public ByteStream::Server {
  protected:
    kj::Promise<void> write(WriteContext context) override { return kj::READY_NOW; }
    kj::Promise<void> done(DoneContext context) override { return kj::READY_NOW; }
    kj::Promise<void> expectSize(ExpectSizeContext context) override { return kj::READY_NOW; }
  };

  kj::String makeDestinationHeader(kj::StringPtr destination) {
    for (char c: destination) {
      KJ_ASSERT(c > ' ' && c != ',', "invalid destination", destination);
    }
    return kj::str("Destination: ", basePath, destination);
  }

  kj::String makeOverwriteHeader(bool noOverwrite) {
    return noOverwrite ? kj::heapString("Overwrite: F")
                       : kj::heapString("Overwrite: T");
  }

  kj::String makeDepthHeader(bool shallow) {
    return shallow ? kj::heapString("Depth: 0")
                   : kj::heapString("Depth: infinity");
  }
};

class EmailSessionImpl final: public HackEmailSession::Server {
public:
  kj::Promise<void> send(SendContext context) override {
    // We're receiving an e-mail. We place the message in maildir format under /var/mail.

    auto email = context.getParams().getEmail();
    auto id = genRandomString();

    // TODO(perf): The following does a lot more copying than necessary.

    // Construct the mail file.
    kj::Vector<kj::String> lines;

    addDateHeader(lines, email.getDate());

    addHeader(lines, "To", email.getTo());
    addHeader(lines, "From", email.getFrom());
    addHeader(lines, "Reply-To", email.getReplyTo());
    addHeader(lines, "CC", email.getCc());
    addHeader(lines, "BCC", email.getBcc());
    addHeader(lines, "Subject", email.getSubject());

    addHeader(lines, "Message-Id", email.getMessageId());
    addHeader(lines, "References", email.getReferences());
    addHeader(lines, "In-Reply-To", email.getInReplyTo());

    addHeader(lines, "Content-Type",
        kj::str("multipart/alternative; boundary=", id));

    lines.add(nullptr);  // blank line starts body.

    if (email.hasText()) {
      lines.add(kj::str("--", id));
      addHeader(lines, "Content-Type", kj::str("text/plain; charset=UTF-8"));
      lines.add(nullptr);
      lines.add(kj::str(email.getText()));
    }
    if (email.hasHtml()) {
      lines.add(kj::str("--", id));
      addHeader(lines, "Content-Type", kj::str("text/html; charset=UTF-8"));
      lines.add(nullptr);
      lines.add(kj::str(email.getHtml()));
    }
    for (auto attachment : email.getAttachments()) {
      addAttachment(lines, id, attachment);
    }
    lines.add(kj::str("--", id, "--"));

    lines.add(nullptr);
    auto text = kj::strArray(lines, "\n");

    // Write to temp file. Prefix name with _ in case `id` starts with '.'.
    auto tmpFilename = kj::str("/var/mail/tmp/_", id);
    auto mailFd = raiiOpen(tmpFilename, O_WRONLY | O_CREAT | O_EXCL);
    kj::FdOutputStream((int)mailFd).write(text.begin(), text.size());
    mailFd = nullptr;

    // Move to final location.
    KJ_SYSCALL(rename(tmpFilename.cStr(), kj::str("/var/mail/new/_", id).cStr()));

    return kj::READY_NOW;
  }

private:
  static kj::String genRandomString() {
    // Generate a unique random string.

    // Get 16 random bytes.
    kj::byte bytes[16];
    kj::FdInputStream(raiiOpen("/dev/urandom", O_RDONLY)).read(bytes, sizeof(bytes));

    // Base64 encode, using digits safe for MIME boundary or a filename.
    static const char DIGITS[65] =
        "0123456789"
        "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
        "abcdefghijklmnopqrstuvwxyz_.";
    uint buffer = 0;
    uint bufBits = 0;
    auto chars = kj::heapArrayBuilder<char>(23);
    for (kj::byte b: bytes) {
      buffer |= b << bufBits;
      bufBits += 8;

      while (bufBits >= 6) {
        chars.add(DIGITS[buffer & 63]);
        buffer >>= 6;
        bufBits -= 6;
      }
    }
    chars.add(DIGITS[buffer & 63]);
    chars.add('\0');

    return kj::String(chars.finish());
  }

  static void addHeader(kj::Vector<kj::String>& lines, kj::StringPtr name, kj::StringPtr value) {
    if (value.size() > 0) {
      lines.add(kj::str(name, ": ", value));
    }
  }

  static kj::String formatAddress(EmailAddress::Reader email) {
    auto name = email.getName();
    auto address = email.getAddress();
    if (name.size() == 0) {
      return kj::str(address);
    } else {
      return kj::str(name, " <", address, ">");
    }
  }

  static void addHeader(kj::Vector<kj::String>& lines, kj::StringPtr name,
                        EmailAddress::Reader email) {
    addHeader(lines, name, formatAddress(email));
  }

  static void addHeader(kj::Vector<kj::String>& lines, kj::StringPtr name,
                        capnp::List<EmailAddress>::Reader emails) {
    addHeader(lines, name, kj::strArray(KJ_MAP(e, emails) { return formatAddress(e); }, ", "));
  }

  static void addHeader(kj::Vector<kj::String>& lines, kj::StringPtr name,
                        capnp::List<capnp::Text>::Reader items) {
    // Used for lists of message IDs (e.g. References an In-Reply-To). Each ID should be "quoted"
    // with <>.
    addHeader(lines, name, kj::strArray(KJ_MAP(i, items) { return kj::str('<', i, '>'); }, " "));
  }

  static void addDateHeader(kj::Vector<kj::String>& lines, int64_t nanoseconds) {
    time_t seconds(nanoseconds / 1000000000u);
    struct tm *tm = gmtime(&seconds);
    char date[40];
    strftime(date, sizeof(date), "%a, %d %b %Y %H:%M:%S %z", tm);

    addHeader(lines, "Date", date);
  }

  static void addAttachment(kj::Vector<kj::String>& lines, kj::StringPtr boundaryId, EmailAttachment::Reader & attachment) {
    lines.add(kj::str("--", boundaryId));
    addHeader(lines, "Content-Type", attachment.getContentType());
    addHeader(lines, "Content-Disposition", attachment.getContentDisposition());
    addHeader(lines, "Content-Transfer-Encoding", "base64");
    addHeader(lines, "Content-Id", attachment.getContentId());
    lines.add(nullptr);

    lines.add(base64Encode(attachment.getContent(), true));
  }
};


class SandstormHttpBridgeImpl: public SandstormHttpBridge::Server {
public:
  explicit SandstormHttpBridgeImpl(SandstormApi<>::Client&& apiCap,
                                   SessionContextMap& sessionContextMap)
      : apiCap(kj::mv(apiCap)),
        sessionContextMap(sessionContextMap) {}

  kj::Promise<void> getSandstormApi(GetSandstormApiContext context) override {
    context.getResults().setApi(apiCap);
    return kj::READY_NOW;
  }

  kj::Promise<void> getSessionContext(GetSessionContextContext context) override {
    auto id = context.getParams().getId();
    auto iter = sessionContextMap.find(id);
    KJ_ASSERT(iter != sessionContextMap.end(), "Session ID not found", id);
    context.getResults().setContext(iter->second);
    return kj::READY_NOW;
  }

private:
  SandstormApi<>::Client apiCap;
  SessionContextMap& sessionContextMap;
};

class UiViewImpl final: public UiView::Server {
public:
  explicit UiViewImpl(kj::NetworkAddress& serverAddress,
                      SessionContextMap& sessionContextMap,
                      spk::BridgeConfig::Reader config)
      : serverAddress(serverAddress), sessionContextMap(sessionContextMap), config(config) {}

  kj::Promise<void> getViewInfo(GetViewInfoContext context) override {
    context.setResults(config.getViewInfo());
    return kj::READY_NOW;
  }

  kj::Promise<void> newSession(NewSessionContext context) override {
    auto params = context.getParams();
    auto sessionType = params.getSessionType();

    KJ_REQUIRE(sessionType == capnp::typeId<WebSession>() ||
               sessionType == capnp::typeId<HackEmailSession>() ||
               (config.getApiPath().size() > 0 && sessionType == capnp::typeId<ApiSession>()),
               "Unsupported session type.");

    if (sessionType == capnp::typeId<WebSession>()) {
      auto userPermissions = params.getUserInfo().getPermissions();
      auto sessionParams = params.getSessionParams().getAs<WebSession::Params>();

      context.getResults(capnp::MessageSize {2, 1}).setSession(
          kj::heap<WebSessionImpl>(serverAddress, params.getUserInfo(), params.getContext(),
                                   sessionContextMap, kj::str(sessionIdCounter++),
                                   hexEncode(params.getTabId()),
                                   kj::heapString(sessionParams.getBasePath()),
                                   kj::heapString(sessionParams.getUserAgent()),
                                   kj::strArray(sessionParams.getAcceptableLanguages(), ","),
                                   kj::heapString("/"),
                                   formatPermissions(userPermissions),
                                   nullptr));
    } else if (sessionType == capnp::typeId<ApiSession>()) {
      auto userPermissions = params.getUserInfo().getPermissions();
      auto sessionParams = params.getSessionParams().getAs<ApiSession::Params>();
      kj::Maybe<kj::String> addr = nullptr;
      if (sessionParams.hasRemoteAddress()) {
        addr = addressToString(sessionParams.getRemoteAddress());
      }

      context.getResults(capnp::MessageSize {2, 1}).setSession(
          kj::heap<WebSessionImpl>(serverAddress, params.getUserInfo(), params.getContext(),
                                   sessionContextMap, kj::str(sessionIdCounter++),
                                   hexEncode(params.getTabId()),
                                   kj::heapString(""), kj::heapString(""), kj::heapString(""),
                                   kj::heapString(config.getApiPath()),
                                   formatPermissions(userPermissions),
                                   kj::mv(addr)));
    } else if (sessionType == capnp::typeId<HackEmailSession>()) {
      context.getResults(capnp::MessageSize {2, 1}).setSession(kj::heap<EmailSessionImpl>());
    }

    return kj::READY_NOW;
  }

private:
  inline kj::String formatPermissions(capnp::List<bool>::Reader& userPermissions) {
    auto configPermissions = config.getViewInfo().getPermissions();
    kj::Vector<kj::String> permissionVec(configPermissions.size());

    for (uint i = 0; i < configPermissions.size() && i < userPermissions.size(); ++i) {
      if (userPermissions[i]) {
        permissionVec.add(kj::str(configPermissions[i].getName()));
      }
    }
    return kj::strArray(permissionVec, ",");
  }

  inline kj::String addressToString(::sandstorm::IpAddress::Reader&& address) {
    uint64_t lower64 = address.getLower64();
    uint64_t upper64 = address.getUpper64();
    if (upper64 == 0 && ((lower64 >> 32) == 0xffff)) {
      // This is an IPv4 address.
      char buf[INET_ADDRSTRLEN];
      memset(buf, 0, INET_ADDRSTRLEN);
      lower64 &= 0xffffffff;
      struct in_addr ipv4;
      ipv4.s_addr = ntohl(uint32_t(lower64));
      const char* ok = inet_ntop(AF_INET, &ipv4, buf, INET_ADDRSTRLEN);
      KJ_REQUIRE(ok != NULL, "inet_ntop() failed");
      kj::String s = kj::heapString(buf);
      return kj::mv(s);
    } else {
      // This is an IPv6 address.
      char buf[INET6_ADDRSTRLEN];
      memset(buf, 0, INET6_ADDRSTRLEN);
      struct in6_addr ipv6;
      ipv6.s6_addr[0]  = ((upper64 >> 56) & 0xff);
      ipv6.s6_addr[1]  = ((upper64 >> 48) & 0xff);
      ipv6.s6_addr[2]  = ((upper64 >> 40) & 0xff);
      ipv6.s6_addr[3]  = ((upper64 >> 32) & 0xff);
      ipv6.s6_addr[4]  = ((upper64 >> 24) & 0xff);
      ipv6.s6_addr[5]  = ((upper64 >> 16) & 0xff);
      ipv6.s6_addr[6]  = ((upper64 >>  8) & 0xff);
      ipv6.s6_addr[7]  = ((upper64      ) & 0xff);
      ipv6.s6_addr[8]  = ((lower64 >> 56) & 0xff);
      ipv6.s6_addr[9]  = ((lower64 >> 48) & 0xff);
      ipv6.s6_addr[10] = ((lower64 >> 40) & 0xff);
      ipv6.s6_addr[11] = ((lower64 >> 32) & 0xff);
      ipv6.s6_addr[12] = ((lower64 >> 24) & 0xff);
      ipv6.s6_addr[13] = ((lower64 >> 16) & 0xff);
      ipv6.s6_addr[14] = ((lower64 >>  8) & 0xff);
      ipv6.s6_addr[15] = ((lower64      ) & 0xff);
      const char* ok = inet_ntop(AF_INET6, &ipv6, buf, INET6_ADDRSTRLEN);
      KJ_REQUIRE(ok != NULL, "inet_ntop() failed");
      kj::String s = kj::heapString(buf);
      return kj::mv(s);
    }
  }

  kj::NetworkAddress& serverAddress;
  SessionContextMap& sessionContextMap;
  spk::BridgeConfig::Reader config;
  uint sessionIdCounter = 0;
  // SessionIds are assigned sequentially.
  // TODO(security): It might be useful to make these sessionIds more random, to reduce the chance
  //   that an app will mix them up.
};

class LegacyBridgeMain {
  // Main class for the Sandstorm legacy bridge.  This program is meant to run inside an
  // application sandbox where it translates incoming requests back from HTTP-over-RPC to regular
  // HTTP.  This is a shim meant to make it easy to port existing web frameworks into Sandstorm,
  // but long-term apps should seek to drop this binary and instead speak Cap'n Proto directly.
  // It is up to the app to include this binary in their package if they want it.

public:
  LegacyBridgeMain(kj::ProcessContext& context): context(context), ioContext(kj::setupAsyncIo()) {
    kj::UnixEventPort::captureSignal(SIGCHLD);
  }

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                           "Acts as a Sandstorm init application.  Runs <command>, then tries to "
                           "connect to it as an HTTP server at the given address (typically, "
                           "'127.0.0.1:<port>') in order to handle incoming requests.")
        .expectArg("<port>", KJ_BIND_METHOD(*this, setPort))
        .expectOneOrMoreArgs("<command>", KJ_BIND_METHOD(*this, addCommandArg))
        .callAfterParsing(KJ_BIND_METHOD(*this, run))
        .build();
  }

  kj::MainBuilder::Validity setPort(kj::StringPtr port) {
    return ioContext.provider->getNetwork().parseAddress(kj::str("127.0.0.1:", port))
        .then([this](kj::Own<kj::NetworkAddress>&& parsedAddr) -> kj::MainBuilder::Validity {
      this->address = kj::mv(parsedAddr);
      return true;
    }, [](kj::Exception&& e) -> kj::MainBuilder::Validity {
      return "invalid port";
    }).wait(ioContext.waitScope);
  }

  kj::MainBuilder::Validity addCommandArg(kj::StringPtr arg) {
    command.add(kj::heapString(arg));
    return true;
  }

  struct AcceptedConnection {
    kj::Own<kj::AsyncIoStream> connection;
    capnp::TwoPartyVatNetwork network;
    capnp::RpcSystem<capnp::rpc::twoparty::VatId> rpcSystem;

    explicit AcceptedConnection(SandstormHttpBridge::Client bridge,
                                kj::Own<kj::AsyncIoStream>&& connectionParam)
      : connection(kj::mv(connectionParam)),
        network(*connection, capnp::rpc::twoparty::Side::SERVER),
        rpcSystem(capnp::makeRpcServer(network, bridge)) {}
  };

  kj::Promise<void> acceptLoop(kj::ConnectionReceiver& serverPort,
                               SandstormHttpBridge::Client bridge,
                               kj::TaskSet& taskSet) {
    return serverPort.accept().then(
        [&, KJ_MVCAP(bridge)](kj::Own<kj::AsyncIoStream>&& connection) mutable {
      auto connectionState = kj::heap<AcceptedConnection>(bridge, kj::mv(connection));
      auto promise = connectionState->network.onDisconnect();
      taskSet.add(promise.attach(kj::mv(connectionState)));
      return acceptLoop(serverPort, kj::mv(bridge), taskSet);
    });
  }

  class ErrorHandlerImpl: public kj::TaskSet::ErrorHandler {
  public:
    void taskFailed(kj::Exception&& exception) override {
      KJ_LOG(ERROR, "connection failed", exception);
    }
  };

  kj::MainBuilder::Validity run() {
    pid_t child;
    KJ_SYSCALL(child = fork());
    if (child == 0) {
      // We're in the child.
      close(3);  // Close Supervisor's Cap'n Proto socket to avoid confusion.

      // Clear signal mask and reset signal disposition.
      // TODO(cleanup): This is kind of dependent on implementation details of kj/async-unix.c++,
      //   especially the part about SIGPIPE. It belongs in the KJ library.
      sigset_t sigset;
      KJ_SYSCALL(sigemptyset(&sigset));
      KJ_SYSCALL(sigprocmask(SIG_SETMASK, &sigset, nullptr));
      KJ_SYSCALL(signal(SIGPIPE, SIG_DFL));

      char* argv[command.size() + 1];
      for (uint i: kj::indices(command)) {
        argv[i] = const_cast<char*>(command[i].cStr());
      }
      argv[command.size()] = nullptr;

      char** argvp = argv;  // work-around Clang not liking lambda + vararray

      KJ_SYSCALL(execvp(argvp[0], argvp), argvp[0]);
      KJ_UNREACHABLE;
    } else {
      // We're in the parent.

      auto exitPromise = onChildExit(child).then([this](int status) {
        KJ_ASSERT(WIFEXITED(status) || WIFSIGNALED(status));
        if (WIFSIGNALED(status)) {
          context.exitError(kj::str(
              "** HTTP-BRIDGE: App server exited due to signal ", WTERMSIG(status),
              " (", strsignal(WTERMSIG(status)), ")."));
        } else {
          context.exitError(kj::str(
              "** HTTP-BRIDGE: App server exited with status code: ", WEXITSTATUS(status)));
        }
      }).eagerlyEvaluate([this](kj::Exception&& e) {
        context.exitError(kj::str(
            "** HTTP-BRIDGE: Uncaught exception waiting for child process:\n", e));
      });

      // Wait until connections are accepted.
      // TODO(soon): Don't block pure-Cap'n-Proto RPCs on this. Just block HTTP requests.
      bool success = false;
      for (;;) {
        kj::runCatchingExceptions([&]() {
          address->connect().wait(ioContext.waitScope);
          success = true;
        });
        if (success) break;

        // Wait 10ms and try again.
        usleep(10000);
      }

      // We potentially re-traverse the BridgeConfig on every request, so make sure to max out the
      // traversal limit.
      capnp::ReaderOptions options;
      options.traversalLimitInWords = kj::maxValue;
      capnp::StreamFdMessageReader reader(
          raiiOpen("/sandstorm-http-bridge-config", O_RDONLY), options);
      auto config = reader.getRoot<spk::BridgeConfig>();

      SessionContextMap sessionContextMap;

      // Set up the Supervisor API socket.
      auto stream = ioContext.lowLevelProvider->wrapSocketFd(3);
      capnp::TwoPartyVatNetwork network(*stream, capnp::rpc::twoparty::Side::CLIENT);
      auto rpcSystem = capnp::makeRpcServer(network,
          kj::heap<UiViewImpl>(*address, sessionContextMap, config));

      // Get the SandstormApi by restoring a null SturdyRef.
      capnp::MallocMessageBuilder message;
      auto vatId = message.initRoot<capnp::rpc::twoparty::VatId>();
      vatId.setSide(capnp::rpc::twoparty::Side::SERVER);
      SandstormApi<>::Client api = rpcSystem.bootstrap(vatId).castAs<SandstormApi<>>();

      // Export a Unix socket on which the application can connect and make calls directly to the
      // Sandstorm API.
      SandstormHttpBridge::Client sandstormHttpBridge =
          kj::heap<SandstormHttpBridgeImpl>(kj::mv(api), sessionContextMap);
      ErrorHandlerImpl errorHandler;
      kj::TaskSet tasks(errorHandler);
      unlink("/tmp/sandstorm-api");  // Clear stale socket, if any.
      auto acceptTask = ioContext.provider->getNetwork()
          .parseAddress("unix:/tmp/sandstorm-api", 0)
          .then([&, KJ_MVCAP(sandstormHttpBridge)](kj::Own<kj::NetworkAddress>&& addr) mutable {
        auto serverPort = addr->listen();
        auto promise = acceptLoop(*serverPort, kj::mv(sandstormHttpBridge), tasks);
        return promise.attach(kj::mv(serverPort));
      });

      exitPromise.wait(ioContext.waitScope);
      KJ_UNREACHABLE;  // exitPromise always exits before completing
    }
  }

private:
  kj::ProcessContext& context;
  kj::AsyncIoContext ioContext;
  kj::Own<kj::NetworkAddress> address;
  kj::Vector<kj::String> command;

  kj::Promise<int> onChildExit(pid_t pid) {
    int status;
    int waitResult;
    KJ_SYSCALL(waitResult = waitpid(pid, &status, WNOHANG));
    if (waitResult == 0) {
      return ioContext.unixEventPort.onSignal(SIGCHLD).then([this,pid](siginfo_t&& info) {
        return onChildExit(pid);
      });
    } else {
      return status;
    }
  }
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::LegacyBridgeMain)
