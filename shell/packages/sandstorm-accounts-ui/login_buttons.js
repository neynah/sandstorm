// for convenience
const loginButtonsSession = Accounts._loginButtonsSession;

const helpers = {
  isCurrentRoute: function (routeName) {
    return Router.current().route.getName() == routeName;
  },

  isDemoUser: function () {
    return this._db.isDemoUser();
  },
};

Template.loginButtons.helpers(helpers);
Template.loginButtonsPopup.helpers(helpers);
Template._loginButtonsLoggedOutDropdown.helpers(helpers);
Template._loginButtonsLoggedInDropdown.helpers(helpers);

Template.loginButtonsPopup.onRendered(function () {
  let element = this.find(".login-buttons-list :first-child");
  if (!element) {
    element = this.find(".login-suggestion button.login");
  }

  if (element) element.focus();
});

Template.accountButtonsPopup.onRendered(function () {
  const element = this.find(".account-buttons-list :first-child");
  if (element) element.focus();
});

Template.accountButtonsPopup.events({
  "click button.logout": function () {
    // TODO(cleanup): Don't rely on global var set in outermost package!
    logoutSandstorm();
  },
});

const displayName = function () {
  const currentIdentityId = Accounts.getCurrentIdentityId();
  const user = Meteor.users.findOne({ _id: currentIdentityId });
  if (!user) return "(incognito)";

  SandstormDb.fillInProfileDefaults(user);
  return user.profile.name;
};

Template.accountButtons.helpers({
  displayName: displayName,
});

function getServices() {
  return _.keys(Accounts.identityServices).map(function (key) {
    return _.extend(Accounts.identityServices[key], { name: key });
  }).filter(function (service) {
    return service.isEnabled() && !!service.loginTemplate;
  }).sort(function (s1, s2) { return s1.loginTemplate.priority - s2.loginTemplate.priority; });
}

Template._loginButtonsMessages.helpers({
  errorMessage: function () {
    return loginButtonsSession.get("errorMessage");
  },
});

Template._loginButtonsMessages.helpers({
  infoMessage: function () {
    return loginButtonsSession.get("infoMessage");
  },
});

const loginResultCallback = function (serviceName, err) {
  if (!err) {
    loginButtonsSession.closeDropdown();
  } else if (err instanceof Accounts.LoginCancelledError) {
    // do nothing
  } else if (err instanceof ServiceConfiguration.ConfigError) { // jscs:ignore disallowEmptyBlocks
    loginButtonsSession.errorMessage(
      "Configuration problem: " + err.message + ". Please visit the Admin Settings page within " +
      "Sandstorm, or ask your administrator to do so. You may need an admin token. Read more by " +
      "clicking Troubleshooting below.");
  } else {
    loginButtonsSession.errorMessage(err.reason || "Unknown error");
  }
};

// In the login redirect flow, we'll have the result of the login
// attempt at page load time when we're redirected back to the
// application.  Register a callback to update the UI (i.e. to close
// the dialog on a successful login or display the error on a failed
// login).
//
Accounts.onPageLoadLogin(function (attemptInfo) {
  // Ignore if we have a left over login attempt for a service that is no longer registered.
  if (_.contains(_.pluck(getServices(), "name"), attemptInfo.type))
    loginResultCallback(attemptInfo.type, attemptInfo.error);
});

Template._loginButtonsLoggedOutDropdown.onCreated(function () {
  this._topbar = Template.parentData(3);
  this._choseLogin = new ReactiveVar(false);
});

Template._loginButtonsLoggedOutDropdown.helpers({
  choseLogin: function () {
    return Template.instance()._choseLogin.get();
  },
});

Template._loginButtonsLoggedOutDropdown.events({
  "click .login-suggestion>button.login": function (event, instance) {
    instance._choseLogin.set(true);
  },

  "click .login-suggestion>button.dismiss": function (event, instance) {
    instance._topbar.closePopup();
  },
});

Template._loginButtonsLoggedInDropdown.onCreated(function () {
  this._identitySwitcherExpanded = new ReactiveVar(false);
});

Template._loginButtonsLoggedInDropdown.helpers({
  displayName: displayName,
  showIdentitySwitcher: function () {
    return SandstormDb.getUserIdentityIds(Meteor.user()).length > 1;
  },

  identitySwitcherExpanded: function () {
    return Template.instance()._identitySwitcherExpanded.get();
  },

  identitySwitcherData: function () {
    const identities = SandstormDb.getUserIdentityIds(Meteor.user()).map(function (id) {
      const identity = Meteor.users.findOne({ _id: id });
      if (identity) {
        SandstormDb.fillInProfileDefaults(identity);
        SandstormDb.fillInIntrinsicName(identity);
        SandstormDb.fillInPictureUrl(identity);
        return identity;
      }
    });

    function onPicked(identityId) {
      Accounts.setCurrentIdentityId(identityId);
    }

    return { identities: identities, onPicked: onPicked,
             currentIdentityId: Accounts.getCurrentIdentityId(), };
  },

});

Template._loginButtonsLoggedInDropdown.events({
  "click button.switch-identity": function (event, instance) {
    instance._identitySwitcherExpanded.set(!instance._identitySwitcherExpanded.get());
  },
});

const sendEmail = function (email, linkingNewIdentity) {
  loginButtonsSession.infoMessage("Sending email...");
  Accounts.createAndEmailTokenForUser(email, linkingNewIdentity, function (err) {
    if (err) {
      loginButtonsSession.errorMessage(err.reason || "Unknown error");
      if (err.error === 409) {
        // 409 is a special case where the user can resolve the problem on their own.
        // Specifically, we're using 409 to mean that the email wasn't sent because a rate limit
        // was hit.
        loginButtonsSession.set("inSignupFlow", email);
      }
    } else {
      loginButtonsSession.set("inSignupFlow", email);
      loginButtonsSession.resetMessages();
    }
  });
};

const loginWithToken = function (email, token) {
  loginButtonsSession.infoMessage("Logging in...");
  Meteor.loginWithEmailToken(email, token, function (err) {
    if (err) {
      loginButtonsSession.errorMessage(err.reason || "Unknown error");
    } else {
      loginButtonsSession.set("inSignupFlow", false);
      loginButtonsSession.closeDropdown();
    }
  });
};

Template.loginButtonsDialog.helpers({
  allowUninvited: function () {
    return Meteor.settings.public.allowUninvited;
  },
});

Template.loginButtonsList.onCreated(function () {
  if (isDemoUser()) {
    this._linkingNewIdentity = { doneCallback: function () {} };
  } else if (Template.parentData(1).linkingNewIdentity) {
    this._linkingNewIdentity = Template.parentData(1).linkingNewIdentity;
  }
});

Template.oauthLoginButton.events({
  "click button.login.oneclick": function (event, instance) {
    if (instance.data.linkingNewIdentity) {
      sessionStorage.setItem("linkingIdentityLoginToken", Accounts._storedLoginToken());
    }

    loginButtonsSession.resetMessages();

    const loginWithService = Meteor[instance.data.data.method];

    const serviceName = instance.data.data.displayName;
    loginWithService({}, function (err) {
      loginResultCallback(serviceName, err);
    });
  },
});

Template.loginButtonsList.helpers({
  configured: function () {
    return !!ServiceConfiguration.configurations.findOne({ service: this.name }) ||
           Template.instance().data._services.get(this.name);
  },

  services: getServices,

  showTroubleshooting: function () {
    return !(Meteor.settings && Meteor.settings.public &&
      Meteor.settings.public.hideTroubleshooting);
  },

  linkingNewIdentity: function () {
    return Template.instance()._linkingNewIdentity;
  },
});

Template.emailAuthenticationForm.events({
  "submit form": function (event, instance) {
    event.preventDefault();
    const form = event.currentTarget;
    const email = loginButtonsSession.get("inSignupFlow");
    if (email) {
      if (instance.data.linkingNewIdentity) {
        Meteor.call("linkEmailIdentityToAccount", email, form.token.value, function (err, result) {
          if (err) {
            loginButtonsSession.errorMessage(err.reason || "Unknown error");
          } else {
            loginButtonsSession.set("inSignupFlow", false);
            loginButtonsSession.closeDropdown();
            instance.data.linkingNewIdentity.doneCallback();
          }
        });
      } else {
        loginWithToken(email, form.token.value);
      }
    } else {
      sendEmail(form.email.value, !!instance.data.linkingNewIdentity);
    }
  },

  "click button.cancel": function (event) {
    loginButtonsSession.set("inSignupFlow", false);
    loginButtonsSession.resetMessages();
  },
});

Template.emailAuthenticationForm.helpers({
  disabled: function () {
    return !(Accounts.identityServices.email && Accounts.identityServices.email.isEnabled());
  },

  awaitingToken: function () {
    return loginButtonsSession.get("inSignupFlow");
  },
});

Template.ldapLoginForm.events({
  "submit form": function (event, instance) {
    event.preventDefault();
    if (instance.data.linkingNewIdentity) {
      sessionStorage.setItem("linkingIdentityLoginToken", Accounts._storedLoginToken());
    }

    loginButtonsSession.resetMessages();

    const form = event.currentTarget;

    const username = form.username.value;
    const password = form.password.value;

    Meteor.loginWithLDAP(username, password, function (err) {
      if (err) {
        loginButtonsSession.errorMessage(err.reason || "Unknown error");
      }
    });
  },
});

Template.devLoginForm.onCreated(function () {
  this._expanded = new ReactiveVar(false);
});

Template.devLoginForm.helpers({
  expanded: function () {
    return Template.instance()._expanded.get();
  },
});

function loginDevHelper(name, isAdmin, linkingNewIdentity) {
  if (linkingNewIdentity) {
    sessionStorage.setItem("linkingIdentityLoginToken", Accounts._storedLoginToken());
  }

  loginDevAccount(name, isAdmin);
}

Template.devLoginForm.events({
  "click button.expand": function (event, instance) {
    event.preventDefault();
    instance._expanded.set(true);
  },

  "click button.unexpand": function (event, instance) {
    event.preventDefault();
    instance._expanded.set(false);
  },

  "click button.login-dev-account": function (event, instance) {
    const displayName = event.currentTarget.getAttribute("data-name");
    const isAdmin = !!event.currentTarget.getAttribute("data-is-admin");
    loginDevHelper(displayName, isAdmin, instance.data.linkingNewIdentity);
  },

  "submit form": function (event, instance) {
    event.preventDefault();
    const form = instance.find("form");
    loginDevHelper(form.name.value, false, instance.data.linkingNewIdentity);
  },
});

Template.samlLoginForm.events({
  "click button": function (event, instance) {
    if (linkingNewIdentity) {
      sessionStorage.setItem("linkingIdentityLoginToken", Accounts._storedLoginToken());
    }

    loginButtonsSession.resetMessages();

    Meteor.loginWithSaml({
      provider: "default",
    }, function (error, result) {
      if (error) {
        loginButtonsSession.errorMessage(error.reason || "Unknown error");
      }
    });
  },
});
