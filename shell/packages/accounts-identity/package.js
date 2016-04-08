// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
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

Package.describe({
  summary: "Accounts with multiple associated identities.",
  version: "0.1.0",
});

Package.onUse(function (api) {
  api.use("ecmascript");
  api.use(["underscore", "random", "reactive-var", "sandstorm-db", "sandstorm-backend", "mongo"]);
  api.use("accounts-base", ["client", "server"]);
  api.use(["session", "templating"], ["client"]);
  api.imply("accounts-base", ["client", "server"]);
  api.use("check");

  api.addFiles(["accounts-identity.html", "accounts-identity-client.js"], ["client"]);
  api.addFiles(["accounts-identity-server.js"], ["server"]);
});
