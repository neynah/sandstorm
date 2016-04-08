Accounts.emailToken = {};

Accounts.emailToken._hashToken = function (token) {
  return {
    digest: SHA256(token),
    algorithm: "sha-256",
  };
};

Router.route("/_emailLogin/:_email/:_token", function () {
  this.render("Loading");
  Meteor.loginWithEmailToken(this.params._email, this.params._token, (err) => {
    if (err) {
      this.render("_emailTokenError", {
        data: function () {
          return {
            error: err,
          };
        },
      });
    } else {
      Router.go("/");
    }
  });
}, {
  // Specify a name in an attempt to fix bug reported here:
  //   https://twitter.com/fink_/status/709715523513270272
  //
  // The user reported an exception trace where IronRouter complained that the route "i" had been
  // registered twice, tracing back to routes in this file. Where did "i" come from? The problem
  // does not seem to be reproducible.
  //
  // It looks like IronRouter may decide to name the route based on the function name:
  //   https://github.com/iron-meteor/iron-middleware-stack/blob/master/lib/handler.js#L49
  //
  // Our function has no name, but perhaps minification can mess with that? An explicit name
  // in the options will take precedence, so do that.
  name: "_emailLogin",
});

Router.route("/_emailLinkIdentity/:_email/:_token/:_accountId", function () {
  this.render("Loading");
  if (this.state.get("error")) {
    this.render("_emailLinkIdentityError", { data: { error: this.state.get("error") } });
  } else {
    if (Meteor.userId() === this.params._accountId) {
      Meteor.call("linkEmailIdentityToAccount",
                  this.params._email, this.params._token, (err, result) => {
                    if (err) {
                      this.state.set("error", err.toString());
                    } else {
                      Router.go("/account");
                    }
                  });
    } else {
      this.render("_emailLinkIdentityError");
    }
  }
}, {
  // See above.
  name: "_emailLinkIdentity",
});
