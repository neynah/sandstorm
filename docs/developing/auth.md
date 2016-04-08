A Sandstorm app delegates authentication to the Sandstorm
platform. This page explains how to identify human visitors to an app
via HTTP(S). For information on authenticating mobile apps, native
clients, and other automated agents, see [Exporting HTTP
APIs](http-apis.md).

## About sandstorm-http-bridge

When a web app runs within Sandstorm, Sandstorm sanitizes all HTTP
requests. By default, it passes requests to your app via a tool called
`sandstorm-http-bridge`. This results in a few interesting properties:

* Sandstorm knows *which user* is making the request, so it can add
  headers indicating the currently logged-in user's name
  ("authentication").

* Sandstorm knows *which permissions the user has* -- for example, it
  knows if the user owns this grain -- so it can add headers
  indicating what permissions the user has ("authorization").

* When your app receives HTTP requests, `sandstorm-http-bridge` has
  normalized them. If a user's browser is speaking some non-compliant
  dialect of HTTP, your app doesn't have to handle it.

### Headers that an app receives

Per the
[current implementation](https://github.com/sandstorm-io/sandstorm/blob/411b344f3acb151693036f3c061b153a2fd91d68/src/sandstorm/sandstorm-http-bridge.c%2B%2B)
of `sandstorm-http-bridge`, an app receives the following headers
related to user identity and permissions:

* `X-Sandstorm-Username`: This is set to the user's full name, in
  [percent-encoded](http://en.wikipedia.org/wiki/Percent-encoding)
  UTF-8. For example, the username `"Kurt Friedrich Gödel"` will
  appear as `"Kurt%20Friedrich%20G%C3%B6del"`.  For anonymous users,
  this header will simply contain "Anonymous%20User".

* `X-Sandstorm-User-Id`: If the user is logged in, this is set to the
  user's current user ID, which is the first 128 bits of a
  SHA-256. For example: `0ba26e59c64ec75dedbc11679f267a40`.  This
  header is **not sent at all for anonymous users**.

* `X-Sandstorm-Tab-Id`: Unique identifier for the grain tab in which
  this request is taking place. This can be used to correlate multiple
  requests being performed in the same tab even when the user is
  anonymous. Also, for HTTP APIs, requests using the same API token
  will have the same tab ID, to allow you to correlate requests from
  the same client.

* `X-Sandstorm-Permissions`: This contains a list of the permissions
  held by the current user, joined with a comma such as `edit,read` or
  `read`. Permissions are defined in the package's
  `sandstorm-pkgdef.capnp`. The grain's owner holds every permission
  and can use the "Share" button to authorize other users.

* `X-Sandstorm-Preferred-Handle`: The user's preferred "handle". A
  handle is like a Unix username. It contains only lower-case ASCII
  letters, digits, and underscores, and it never starts with a digit.
  The user can set their preferred handle in their account settings.
  This handle is NOT UNIQUE; it is only a hint from the user. Apps
  that use handles must decide for themselves whether they need
  unique handles and, if so, implement some mechanism to deal with
  duplicates (such as prompting the user to choose a different one,
  or just appending some digits). Apps should strongly consider
  using display names (`X-Sandstorm-Username`) instead of handles.
  **WARNING: A user can change their preferred handle at any time.
  Two users can have the same preferred handle. The preferred handle
  is just another form of display name. Do not use preferred handles
  as primary keys or for security; use `X-Sandstorm-User-Id`
  instead.**

* `X-Sandstorm-User-Picture`: The URL of the user's profile picture.
  The exact resolution of the picture is not specified, but assume
  it is optimized for a 256x256 or smaller viewport (i.e. the actual
  size is around 512x512 for high-DPI displays). Although profile
  pictures are normally square, it is recommended to use CSS `max-width` and
  `max-height` instead of `width` and `height` in order to avoid
  distorting a non-square picture. If this header is missing, the
  user has no profile picture. In this case, it is recommended that
  apps use [identicon.js](https://github.com/stewartlord/identicon.js),
  with the user's ID (from `X-Sandstorm-User-Id`) as the input, to
  produce identicons consistent with those that Sandstorm's own UI
  would produce. Note that you should NOT hash the ID; just pass the
  hex ID directly to the `Identicon` constructor as the `hash`
  argument.

* `X-Sandstorm-User-Pronouns`: Indicates by which pronouns the user
  prefers to be referred. Possible values are `neutral` (English:
  "they"), `male` (English: "he/him"), `female` (English: "she/her"),
  and `robot` (English: "it"). If the header is not present, assume
  `neutral`. The purpose of this header is to allow cleaner text in
  user interfaces.

## Apps operating without sandstorm-http-bridge

It is possible to write a Sandstorm app that does not use
`sandstorm-http-bridge`! It can access authentication data by using
the Cap'n Proto raw Sandstorm API. We provide sample code for that in
the
[sandstorm-rawapi-example](https://github.com/sandstorm-io/sandstorm-rawapi-example)
repository on GitHub.

## Further reading

You might be interested in looking at:

* A [sandstorm-pkgdef.capnp](https://github.com/kentonv/ssjekyll/blob/fd09dbdbd6644abe63c50060044b71556130c30d/sandstorm-pkgdef.capnp)
  with no permissions defined.

* A [sandstorm-pkgdef.capnp](https://github.com/jparyani/mediawiki-sandstorm/blob/8c7a7d10b6121cb5e94247f7ea27a46ebf8e84eb/sandstorm-pkgdef.capnp)
  with one permission defined.

* The [implementation of
  sandstorm-http-bridge](https://github.com/sandstorm-io/sandstorm/blob/411b344f3acb151693036f3c061b153a2fd91d68/src/sandstorm/sandstorm-http-bridge.c%2B%2B).
