/* global Settings */

const idpData = function (configureCallback) {
  const emailTokenEnabled = globalDb.getSettingWithFallback("emailToken", false);
  const googleEnabled = globalDb.getSettingWithFallback("google", false);
  const githubEnabled = globalDb.getSettingWithFallback("github", false);
  const ldapEnabled = globalDb.getSettingWithFallback("ldap", false);
  const samlEnabled = globalDb.getSettingWithFallback("saml", false);
  return [
    {
      id: "email-token",
      label: "E-mail (passwordless)",
      icon: "/email.svg", // Or use identicons
      enabled: emailTokenEnabled,
      popupTemplate: "adminIdentityProviderConfigureEmail",
      onConfigure() {
        configureCallback("email-token");
      },
    },
    {
      id: "google",
      label: "Google",
      icon: "/google.svg", // Or use identicons
      enabled: googleEnabled,
      popupTemplate: "adminIdentityProviderConfigureGoogle",
      onConfigure() {
        configureCallback("google");
      },
    },
    {
      id: "github",
      label: "GitHub",
      icon: "/github.svg", // Or use identicons
      enabled: githubEnabled,
      popupTemplate: "adminIdentityProviderConfigureGitHub",
      onConfigure() {
        configureCallback("github");
      },
    },
    {
      id: "ldap",
      label: "LDAP",
      icon: "/ldap.svg", // Or use identicons
      enabled: ldapEnabled,
      restricted: true,
      popupTemplate: "adminIdentityProviderConfigureLdap",
      onConfigure() {
        configureCallback("ldap");
      },
    },
    {
      id: "saml",
      label: "SAML",
      icon: "/ldap.svg", // Or use identicons
      enabled: samlEnabled,
      restricted: true,
      popupTemplate: "adminIdentityProviderConfigureSaml",
      onConfigure() {
        configureCallback("saml");
      },
    },
  ];
};

Template.adminIdentityProviderTable.onCreated(function () {
  this.currentPopup = new ReactiveVar(undefined);
});

Template.adminIdentityProviderTable.helpers({
  idpData() {
    const instance = Template.instance();
    return idpData((idp) => {
      instance.currentPopup.set(idp);
    });
  },

  currentPopupIs(arg) {
    const instance = Template.instance();
    return instance.currentPopup.get() === arg;
  },

  popupData() {
    const instance = Template.instance();
    // The data context passed in to the popupTemplate instance, as specified in the idpData above.
    return {
      onDismiss() {
        return () => {
          instance.currentPopup.set(undefined);
        };
      },
    };
  },
});

Template.adminIdentityRow.events({
  "click button.configure-idp"() {
    const instance = Template.instance();
    instance.data.idp.onConfigure();
  },

  "click button.get-feature-key"() {
    // TODO: non-setup-UI probably shouldn't do this.  Pass in a callback instead?
    Router.go("setupWizardFeatureKey");
  },
});

Template.adminIdentityRow.helpers({
  needsFeatureKey() {
    const instance = Template.instance();
    const featureKeyValid = globalDb.isFeatureKeyValid();
    return instance.data.idp.restricted && !featureKeyValid;
  },
});

Template.modalDialogWithBackdrop.onCreated(function () {
  // This keypress event listener which closes the dialog when Escape is pressed should be scoped to
  // the browser window, not this template.
  this.keypressListener = (evt) => {
    if (evt.keyCode === 27) {
      this.data.onDismiss && this.data.onDismiss();
    }
  };

  window.addEventListener("keydown", this.keypressListener);
  document.getElementsByTagName("body")[0].classList.add("modal-shown");
});

Template.modalDialogWithBackdrop.onDestroyed(function () {
  window.removeEventListener("keydown", this.keypressListener);
  document.getElementsByTagName("body")[0].classList.remove("modal-shown");
});

Template.modalDialogWithBackdrop.events({
  "click .modal"(evt) {
    if (evt.currentTarget === evt.target) {
      // Only dismiss if the click was on the backdrop, not the main form.
      const instance = Template.instance();
      instance.data.onDismiss && instance.data.onDismiss();
    }
  },

  "click .modal-close-button"(evt) {
    const instance = Template.instance();
    instance.data.onDismiss && instance.data.onDismiss();
  },
});

// Email form.
Template.adminIdentityProviderConfigureEmail.onCreated(function () {
  const emailEnabled = globalDb.getSettingWithFallback("emailToken", false);
  this.emailChecked = new ReactiveVar(emailEnabled);
  this.errorMessage = new ReactiveVar(undefined);
});

Template.adminIdentityProviderConfigureEmail.onRendered(function () {
  // Focus the first input when the form is shown.
  this.find("input").focus();
});

Template.adminIdentityProviderConfigureEmail.events({
  "click input[name=enableEmail]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.emailChecked.set(!instance.emailChecked.get());
  },

  "click .idp-modal-save"(evt) {
    const instance = Template.instance();
    const enableEmail = instance.emailChecked.get();
    const token = Iron.controller().state.get("token");
    Meteor.call("setAccountSetting", token, "emailToken", enableEmail, (err) => {
      if (err) {
        instance.errorMessage.set(err.message);
      } else {
        instance.data.onDismiss()();
      }
    });
  },

  "click .idp-modal-cancel"(evt) {
    const instance = Template.instance();
    // double invocation because there's no way to pass a callback function around in Blaze without
    // invoking it, and we need to pass it to modalDialogWithBackdrop
    instance.data.onDismiss()();
  },
});

Template.adminIdentityProviderConfigureEmail.helpers({
  emailChecked() {
    const instance = Template.instance();
    return instance.emailChecked.get();
  },

  errorMessage() {
    const instance = Template.instance();
    return instance.errorMessage.get();
  },
});

// Google form.
Template.adminIdentityProviderConfigureGoogle.onCreated(function () {
  const googleChecked = globalDb.getSettingWithFallback("google", false);

  const configurations = Package["service-configuration"].ServiceConfiguration.configurations;
  const googleConfiguration = configurations.findOne({ service: "google" });
  const clientId = googleConfiguration && googleConfiguration.clientId;
  const clientSecret = googleConfiguration && googleConfiguration.secret;

  this.googleChecked = new ReactiveVar(googleChecked);
  this.clientId = new ReactiveVar(clientId);
  this.clientSecret = new ReactiveVar(clientSecret);
  this.errorMessage = new ReactiveVar(undefined);
});

Template.adminIdentityProviderConfigureGoogle.onRendered(function () {
  // Focus the first input when the form is shown.
  this.find("input").focus();
});

Template.adminIdentityProviderConfigureGoogle.helpers({
  googleChecked() {
    const instance = Template.instance();
    return instance.googleChecked.get();
  },

  clientId() {
    const instance = Template.instance();
    return instance.clientId.get();
  },

  clientSecret() {
    const instance = Template.instance();
    return instance.clientSecret.get();
  },

  saveHtmlDisabled() {
    const instance = Template.instance();
    if (instance.googleChecked.get() && (!instance.clientId.get() || !instance.clientSecret.get())) {
      return "disabled";
    }

    return "";
  },

  errorMessage() {
    const instance = Template.instance();
    return instance.errorMessage.get();
  },
});

Template.adminIdentityProviderConfigureGoogle.events({
  "click input[name=enableGoogle]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.googleChecked.set(!instance.googleChecked.get());
  },

  "input input[name=clientId]"(evt) {
    const instance = Template.instance();
    instance.clientId.set(evt.currentTarget.value);
  },

  "input input[name=clientSecret]"(evt) {
    const instance = Template.instance();
    instance.clientSecret.set(evt.currentTarget.value);
  },

  "click .idp-modal-save"(evt) {
    const instance = Template.instance();
    const enableGoogle = instance.googleChecked.get();
    const token = Iron.controller().state.get("token");
    const configuration = {
      service: "google",
      clientId: instance.clientId.get(),
      secret: instance.clientSecret.get(),
      loginStyle: "redirect",
    };
    // TODO: rework this into a single Meteor method call.
    Meteor.call("adminConfigureLoginService", token, configuration, (err) => {
      if (err) {
        instance.errorMessage.set(err.message);
      } else {
        Meteor.call("setAccountSetting", token, "google", enableGoogle, (err) => {
          if (err) {
            instance.errorMessage.set(err.message);
          } else {
            instance.data.onDismiss()();
          }
        });
      }
    });
  },

  "click .idp-modal-cancel"(evt) {
    const instance = Template.instance();
    // double invocation because there's no way to pass a callback function around in Blaze without
    // invoking it, and we need to pass it to modalDialogWithBackdrop
    instance.data.onDismiss()();
  },
});

// GitHub form.
Template.adminIdentityProviderConfigureGitHub.onCreated(function () {
  const githubChecked = globalDb.getSettingWithFallback("github", false);

  const configurations = Package["service-configuration"].ServiceConfiguration.configurations;
  const githubConfiguration = configurations.findOne({ service: "github" });
  const clientId = githubConfiguration && githubConfiguration.clientId;
  const clientSecret = githubConfiguration && githubConfiguration.secret;

  this.githubChecked = new ReactiveVar(githubChecked);
  this.clientId = new ReactiveVar(clientId);
  this.clientSecret = new ReactiveVar(clientSecret);
  this.errorMessage = new ReactiveVar(undefined);
});

Template.adminIdentityProviderConfigureGitHub.onRendered(function () {
  // Focus the first input when the form is shown.
  this.find("input").focus();
});

Template.adminIdentityProviderConfigureGitHub.helpers({
  githubChecked() {
    const instance = Template.instance();
    return instance.githubChecked.get();
  },

  clientId() {
    const instance = Template.instance();
    return instance.clientId.get();
  },

  clientSecret() {
    const instance = Template.instance();
    return instance.clientSecret.get();
  },

  saveHtmlDisabled() {
    const instance = Template.instance();
    if (instance.githubChecked.get() && (!instance.clientId.get() || !instance.clientSecret.get())) {
      return "disabled";
    }

    return "";
  },

  errorMessage() {
    const instance = Template.instance();
    return instance.errorMessage.get();
  },
});

Template.adminIdentityProviderConfigureGitHub.events({
  "click input[name=enableGithub]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.githubChecked.set(!instance.githubChecked.get());
  },

  "input input[name=clientId]"(evt) {
    const instance = Template.instance();
    instance.clientId.set(evt.currentTarget.value);
  },

  "input input[name=clientSecret]"(evt) {
    const instance = Template.instance();
    instance.clientSecret.set(evt.currentTarget.value);
  },

  "click .idp-modal-save"(evt) {
    const instance = Template.instance();
    const enableGithub = instance.githubChecked.get();
    const token = Iron.controller().state.get("token");
    const configuration = {
      service: "github",
      clientId: instance.clientId.get(),
      secret: instance.clientSecret.get(),
      loginStyle: "redirect",
    };
    // TODO: rework this into a single Meteor method call.
    Meteor.call("adminConfigureLoginService", token, configuration, (err) => {
      if (err) {
        instance.errorMessage.set(err.message);
      } else {
        Meteor.call("setAccountSetting", token, "github", enableGithub, (err) => {
          if (err) {
            instance.errorMessage.set(err.message);
          } else {
            instance.data.onDismiss()();
          }
        });
      }
    });
  },

  "click .idp-modal-cancel"(evt) {
    const instance = Template.instance();
    // double invocation because there's no way to pass a callback function around in Blaze without
    // invoking it, and we need to pass it to modalDialogWithBackdrop
    instance.data.onDismiss()();
  },
});

// LDAP form.
Template.adminIdentityProviderConfigureLdap.onCreated(function () {
  const ldapChecked = globalDb.getSettingWithFallback("ldap", false);
  const url = globalDb.getLdapUrl();
  const searchBindDn = globalDb.getLdapSearchBindDn();
  const searchBindPassword = globalDb.getLdapSearchBindPassword();
  const base = globalDb.getLdapBase(); //"ou=users,dc=example,dc=com"
  const searchUsername = globalDb.getLdapSearchUsername() || "uid";
  const nameField = globalDb.getLdapNameField() || "cn";
  const emailField = globalDb.getLdapEmailField() || "mail";
  const filter = globalDb.getLdapFilter();

  this.ldapChecked = new ReactiveVar(ldapChecked);
  this.ldapUrl = new ReactiveVar(url);
  this.ldapSearchBindDn = new ReactiveVar(searchBindDn);
  this.ldapSearchBindPassword = new ReactiveVar(searchBindPassword);
  this.ldapBase = new ReactiveVar(base);
  this.ldapSearchUsername = new ReactiveVar(searchUsername);
  this.ldapNameField = new ReactiveVar(nameField);
  this.ldapEmailField = new ReactiveVar(emailField);
  this.ldapFilter = new ReactiveVar(filter);
  this.errorMessage = new ReactiveVar(undefined);
});

Template.adminIdentityProviderConfigureLdap.onRendered(function () {
  // Focus the first input when the form is shown.
  this.find("input").focus();
});

Template.adminIdentityProviderConfigureLdap.helpers({
  ldapChecked() {
    const instance = Template.instance();
    return instance.ldapChecked.get();
  },

  ldapUrl() {
    const instance = Template.instance();
    return instance.ldapUrl.get();
  },

  ldapBase() {
    const instance = Template.instance();
    return instance.ldapBase.get();
  },

  ldapSearchUsername() {
    const instance = Template.instance();
    return instance.ldapSearchUsername.get();
  },

  ldapFilter() {
    const instance = Template.instance();
    return instance.ldapFilter.get();
  },

  ldapSearchBindDn() {
    const instance = Template.instance();
    return instance.ldapSearchBindDn.get();
  },

  ldapSearchBindPassword() {
    const instance = Template.instance();
    return instance.ldapSearchBindPassword.get();
  },

  ldapNameField() {
    const instance = Template.instance();
    return instance.ldapNameField.get();
  },

  ldapEmailField() {
    const instance = Template.instance();
    return instance.ldapEmailField.get();
  },

  saveHtmlDisabled() {
    const instance = Template.instance();
    // Anything goes if the provider is disabled.
    if (!instance.ldapChecked.get()) {
      return "";
    }

    // If the provider is enabled, then you must provide:
    // * a nonempty URL
    // * a nonempty username attribute
    // * a nonempty given name attribute
    // * a nonempty email attribute
    if (!instance.ldapUrl.get() ||
        !instance.ldapSearchUsername.get() ||
        !instance.ldapNameField.get() ||
        !instance.ldapEmailField.get()) {
      return "disabled";
    }

    return "";
  },

  errorMessage() {
    const instance = Template.instance();
    return instance.errorMessage.get();
  },
});

Template.adminIdentityProviderConfigureLdap.events({
  "click input[name=enableLdap]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.ldapChecked.set(!instance.ldapChecked.get());
  },

  "input input[name=ldapUrl]"(evt) {
    const instance = Template.instance();
    instance.ldapUrl.set(evt.currentTarget.value);
  },

  "input input[name=ldapSearchBindDn]"(evt) {
    const instance = Template.instance();
    instance.ldapSearchBindDn.set(evt.currentTarget.value);
  },

  "input input[name=ldapSearchBindPassword]"(evt) {
    const instance = Template.instance();
    instance.ldapSearchBindPassword.set(evt.currentTarget.value);
  },

  "input input[name=ldapBase]"(evt) {
    const instance = Template.instance();
    instance.ldapBase.set(evt.currentTarget.value);
  },

  "input input[name=ldapSearchUsername]"(evt) {
    const instance = Template.instance();
    instance.ldapSearchUsername.set(evt.currentTarget.value);
  },

  "input input[name=ldapNameField]"(evt) {
    const instance = Template.instance();
    instance.ldapNameField.set(evt.currentTarget.value);
  },

  "input input[name=ldapEmailField]"(evt) {
    const instance = Template.instance();
    instance.ldapEmailField.set(evt.currentTarget.value);
  },

  "input input[name=ldapFilter]"(evt) {
    const instance = Template.instance();
    instance.ldapFilter.set(evt.currentTarget.value);
  },

  "click .idp-modal-save"(evt) {
    // TODO(soon): refactor the backend to make this a single Meteor call, and an atomic DB write.
    const instance = Template.instance();
    const token = Iron.controller().state.get("token");

    // A list of settings to save with the setSetting method, in order.
    const settingsToSave = [
      { name: "ldapUrl",                value: instance.ldapUrl.get() },
      { name: "ldapSearchBindDn",       value: instance.ldapSearchBindDn.get() },
      { name: "ldapSearchBindPassword", value: instance.ldapSearchBindPassword.get() },
      { name: "ldapBase",               value: instance.ldapBase.get() },
      { name: "ldapSearchUsername",     value: instance.ldapSearchUsername.get() },
      { name: "ldapNameField",          value: instance.ldapNameField.get() },
      { name: "ldapEmailField",         value: instance.ldapEmailField.get() },
      { name: "ldapFilter",             value: instance.ldapFilter.get() },
    ];

    const saveSettings = function (settingList, errback, callback) {
      const setting = settingList[0];
      Meteor.call("setSetting", token, setting.name, setting.value, (err) => {
        if (err) {
          errback(err);
        } else {
          settingList.shift();
          if (settingList.length === 0) {
            callback();
          } else {
            saveSettings(settingList, errback, callback);
          }
        }
      });
    };

    saveSettings(settingsToSave,
      (err) => { instance.errorMessage.set(err.message); },

      () => {
        // ldap requires the "setAccountSetting" method, so it's separated out here.
        Meteor.call("setAccountSetting", token, "ldap", instance.ldapChecked.get(), (err) => {
          if (err) {
            instance.errorMessage.set(err.message);
          } else {
            instance.data.onDismiss()();
          }
        });
      }
    );
  },

  "click .idp-modal-cancel"(evt) {
    const instance = Template.instance();
    // double invocation because there's no way to pass a callback function around in Blaze without
    // invoking it, and we need to pass it to modalDialogWithBackdrop
    instance.data.onDismiss()();
  },
});

// SAML form.
Template.adminIdentityProviderConfigureSaml.onCreated(function () {
  const samlChecked = globalDb.getSettingWithFallback("saml", false);
  const samlEntryPoint = globalDb.getSamlEntryPoint();
  const samlPublicCert = globalDb.getSamlPublicCert();

  this.samlChecked = new ReactiveVar(samlChecked);
  this.samlEntryPoint = new ReactiveVar(samlEntryPoint);
  this.samlPublicCert = new ReactiveVar(samlPublicCert);
  this.errorMessage = new ReactiveVar(undefined);
});

Template.adminIdentityProviderConfigureSaml.onRendered(function () {
  // Focus the first input when the form is shown.
  this.find("input").focus();
});

Template.adminIdentityProviderConfigureSaml.helpers({
  samlChecked() {
    const instance = Template.instance();
    return instance.samlChecked.get();
  },

  samlEntryPoint() {
    const instance = Template.instance();
    return instance.samlEntryPoint.get();
  },

  samlPublicCert() {
    const instance = Template.instance();
    return instance.samlPublicCert.get();
  },

  saveHtmlDisabled() {
    const instance = Template.instance();
    if (instance.samlChecked.get() &&
            (!instance.samlEntryPoint.get() || !instance.samlPublicCert.get())) {
      return "disabled";
    }

    return "";
  },

  errorMessage() {
    const instance = Template.instance();
    return instance.errorMessage.get();
  },
});

Template.adminIdentityProviderConfigureSaml.events({
  "click input[name=enableSaml]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.samlChecked.set(!instance.samlChecked.get());
  },

  "input input[name=entryPoint]"(evt) {
    const instance = Template.instance();
    instance.samlEntryPoint.set(evt.currentTarget.value);
  },

  "input textarea[name=publicCert]"(evt) {
    const instance = Template.instance();
    instance.samlPublicCert.set(evt.currentTarget.value);
  },

  "click .idp-modal-save"(evt) {
    const instance = Template.instance();
    const enableSaml = instance.samlChecked.get();
    const samlEntryPoint = instance.samlEntryPoint.get();
    const samlPublicCert = instance.samlPublicCert.get();
    const token = Iron.controller().state.get("token");
    // TODO: rework this into a single Meteor method call.
    Meteor.call("setSetting", token, "samlEntryPoint", samlEntryPoint, (err) => {
      if (err) {
        instance.errorMessage.set(err.message);
      } else {
        Meteor.call("setSetting", token, "samlPublicCert", samlPublicCert, (err) => {
          if (err) {
            instance.errorMessage.set(err.message);
          } else {
            Meteor.call("setAccountSetting", token, "saml", enableSaml, (err) => {
              if (err) {
                instance.errorMessage.set(err.message);
              } else {
                instance.data.onDismiss()();
              }
            });
          }
        });
      }
    });
  },

  "click .idp-modal-cancel"(evt) {
    const instance = Template.instance();
    // double invocation because there's no way to pass a callback function around in Blaze without
    // invoking it, and we need to pass it to modalDialogWithBackdrop
    instance.data.onDismiss()();
  },
});
