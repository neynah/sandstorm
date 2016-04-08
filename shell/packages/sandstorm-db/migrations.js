// Minimal tooling for doing run-at-least-once, ordered migrations.
//
// Because migrations can experience partial failure and likely have
// side-effects, we should be careful to make sure all migrations are
// idempotent and safe to accidentally run multiple times.

const Future = Npm.require("fibers/future");
const Url = Npm.require("url");
const Crypto = Npm.require("crypto");

const updateLoginStyleToRedirect = function () {
  const configurations = Package["service-configuration"].ServiceConfiguration.configurations;
  ["google", "github"].forEach(function (serviceName) {
    const config = configurations.findOne({ service: serviceName });
    if (config && config.loginStyle !== "redirect") {
      configurations.update({ service: serviceName }, { $set: { loginStyle: "redirect" } });
    }
  });
};

const enableLegacyOAuthProvidersIfNotInSettings = function () {
  // In the before time, Google and Github login were enabled by default.
  //
  // This actually didn't make much sense, required the first user to configure
  // OAuth, and had some trust-the-first-user properties that weren't totally
  // secure.
  //
  // Now, we have admin-token, so we wish to disable all logins by default
  // (since they need to be configured anyway) but since users may have never
  // explicitly told Sandstorm that Google or Github login should be enabled,
  // we can't just use the value in the Settings collection, since it might
  // never have been set.
  //
  // Thus, if the service is configured but absent from Settings, we should
  // explicitly enable it in Settings, and then the rest of the logic can just
  // depend on what value is in Settings and default to false without breaking
  // user installations.
  const configurations = Package["service-configuration"].ServiceConfiguration.configurations;
  ["google", "github"].forEach(function (serviceName) {
    const config = configurations.findOne({ service: serviceName });
    const serviceConfig = Settings.findOne({ _id: serviceName });
    if (config && !serviceConfig) {
      // Only explicitly enable the login service if:
      // 1) the service is already configured
      // 2) there is no sandstorm configuration already present (the user was
      //    using the previous default behavior).
      Settings.insert({ _id: serviceName, value: true });
    }
  });
};

const denormalizeInviteInfo = function () {
  // When a user is invited via a signup token, the `signupKey` field of their user table entry
  // has always been populated to indicate the key they used. This points into the SignupKeys table
  // which has more information about the key, namely a freeform note entered by the admin when
  // they created the key. In the case that the email invite form was used, the note has the form
  // "E-mail invite to <address>".
  //
  // Later, we decided it was useful to indicate in the users table visible to the admin
  // information about the invite terms. Namely, for email invites we want to show the address
  // and for others we want to show the note. To make this efficient, fields `signupNote` and
  // `signupEmail` were added to the users table. We can backfill these values by denormalizing
  // from the SignupKeys table.

  Meteor.users.find().forEach(function (user) {
    if (user.signupKey && (typeof user.signupKey) === "string" && user.signupKey !== "admin") {
      const signupInfo = SignupKeys.findOne(user.signupKey);
      if (signupInfo && signupInfo.note) {
        const newFields = { signupNote: signupInfo.note };

        const prefix = "E-mail invite to ";
        if (signupInfo.note.lastIndexOf(prefix) === 0) {
          newFields.signupEmail = signupInfo.note.slice(prefix.length);
        }

        Meteor.users.update(user._id, { $set: newFields });
      }
    }
  });
};

function mergeRoleAssignmentsIntoApiTokens() {
  RoleAssignments.find().forEach(function (roleAssignment) {
    ApiTokens.insert({
      grainId: roleAssignment.grainId,
      userId: roleAssignment.sharer,
      roleAssignment: roleAssignment.roleAssignment,
      petname: roleAssignment.petname,
      created: roleAssignment.created,
      owner: { user: { userId: roleAssignment.recipient,
                     title: roleAssignment.title, }, },
    });
  });
}

function fixOasisStorageUsageStats() {}
// This migration only pertained to Oasis and it was successfully applied there. Since it referred
// to some global variables that we later wanted to remove and/or rename, we've since replaced it
// with a no-op.

function fetchProfilePictures() {
  Meteor.users.find({}).forEach(function (user) {
    const url = userPictureUrl(user);
    if (url) {
      console.log("Fetching user picture:", url);
      const assetId = fetchPicture(url);
      if (assetId) {
        Meteor.users.update(user._id, { $set: { "profile.picture": assetId } });
      }
    }
  });
}

function assignPlans() {
  if (Meteor.settings.public.quotaEnabled && SandstormDb.paymentsMigrationHook) {
    SandstormDb.paymentsMigrationHook(SignupKeys, Plans.find().fetch());
  }
}

function removeKeyrings() {
  // These blobs full of public keys were not intended to find their way into mongo and while
  // harmless they slow things down because they're huge. Remove them.
  Packages.update({ "manifest.metadata.pgpKeyring": { $exists: true } },
      { $unset: { "manifest.metadata.pgpKeyring": "" } },
      { multi: true });
}

function useLocalizedTextInUserActions() {
  function toLocalizedText(newObj, oldObj, field) {
    if (field in oldObj) {
      if (typeof oldObj[field] === "string") {
        newObj[field] = { defaultText: oldObj[field] };
      } else {
        newObj[field] = oldObj[field];
      }
    }
  }

  UserActions.find({}).forEach(function (userAction) {
    const fields = {};
    toLocalizedText(fields, userAction, "appTitle");
    toLocalizedText(fields, userAction, "title");
    toLocalizedText(fields, userAction, "nounPhrase");
    UserActions.update(userAction._id, { $set: fields });
  });
}

function verifyAllPgpSignatures() {
  Packages.find({}).forEach(function (pkg) {
    try {
      console.log("checking PGP signature for package:", pkg._id);
      const info = waitPromise(globalBackend.cap().tryGetPackage(pkg._id));
      if (info.authorPgpKeyFingerprint) {
        console.log("  " + info.authorPgpKeyFingerprint);
        Packages.update(pkg._id,
            { $set: { authorPgpKeyFingerprint: info.authorPgpKeyFingerprint } });
      } else {
        console.log("  no signature");
      }
    } catch (err) {
      console.error(err.stack);
    }
  });
}

function splitUserIdsIntoAccountIdsAndIdentityIds() {
  Meteor.users.find().forEach(function (user) {
    const identity = {};
    let serviceUserId;
    if ("devName" in user) {
      identity.service = "dev";
      serviceUserId = user.devName;
    } else if ("expires" in user) {
      identity.service = "demo";
      serviceUserId = user._id;
    } else if (user.services && "google" in user.services) {
      identity.service = "google";
      if (user.services.google.email && user.services.google.verified_email) { // jscs:ignore requireCamelCaseOrUpperCaseIdentifiers
        identity.verifiedEmail = user.services.google.email;
      }

      serviceUserId = user.services.google.id;
    } else if (user.services && "github" in user.services) {
      identity.service = "github";
      identity.unverifiedEmail = user.services.github.email;
      serviceUserId = user.services.github.id;
    } else if (user.services && "emailToken" in user.services) {
      identity.service = "emailToken";
      identity.verifiedEmail = user.services.emailToken.email;
      serviceUserId = user.services.emailToken.email;
    }

    identity.id = Crypto.createHash("sha256")
        .update(identity.service + ":" + serviceUserId).digest("hex");

    if (user.profile) {
      if (user.profile.name) {
        identity.name = user.profile.name;
      }

      if (user.profile.handle) {
        identity.handle = user.profile.handle;
      }

      if (user.profile.picture) {
        identity.picture = user.profile.picture;
      }

      if (user.profile.pronoun) {
        identity.pronoun = user.profile.pronoun;
      }

      if (user.profile.email) {
        identity.unverifiedEmail = user.profile.email;
      }
    }

    identity.main = true;

    Meteor.users.update(user._id, { $set: { identities: [identity] } });

    Grains.update({ userId: user._id }, { $set: { identityId: identity.id } }, { multi: true });
    Sessions.update({ userId: user._id }, { $set: { identityId: identity.id } }, { multi: true });
    ApiTokens.update({ userId: user._id },
                     { $set: { identityId: identity.id } },
                     { multi: true });
    ApiTokens.update({ "owner.user.userId": user._id },
                     { $set: { "owner.user.identityId": identity.id } },
                     { multi: true });
    ApiTokens.update({ "owner.grain.introducerUser": user._id },
                     { $set: { "owner.grain.introducerIdentity": identity.id } },
                     { multi: true });

    while (ApiTokens.update({ "requirements.permissionsHeld.userId": user._id },
                            { $set: { "requirements.$.permissionsHeld.identityId": identity.id },
                             $unset: { "requirements.$.permissionsHeld.userId": 1 }, },
                            { multi: true }) > 0);
    // The `$` operatorer modifies the first element in the array that matches the query. Since
    // there may be many matches, we need to repeat until no documents are modified.

  });

  ApiTokens.remove({ userInfo: { $exists: true } });
  // We've renamed `Grain.UserInfo.userId` to `Grain.userInfo.identityId`. The only place
  // that this field could show up in the database was in this deprecated, no-longer-functional
  // form of API token.
}

function appUpdateSettings() {
  Settings.insert({ _id: "appMarketUrl", value: "https://apps.sandstorm.io" });
  Settings.insert({ _id: "appIndexUrl", value: "https://app-index.sandstorm.io" });
  Settings.insert({ _id: "appUpdatesEnabled", value: true });
}

function moveDevAndEmailLoginDataIntoIdentities() {
  Meteor.users.find().forEach(function (user) {
    if (user.identities.length != 1) {
      throw new Error("User does not have exactly one identity: ", user);
    }

    const identity = user.identities[0];
    if (Match.test(identity.service, Object)) { return; } // Already migrated.

    const newIdentity = _.pick(identity, "id", "main", "noLogin", "verifiedEmail", "unverifiedEmail");
    newIdentity.profile = _.pick(identity, "name", "handle", "picture", "pronoun");

    const serviceObject = {};
    const fieldsToUnset = {};

    if (identity.service === "dev") {
      serviceObject.name = user.devName;
      fieldsToUnset.devName = 1;
    } else if (identity.service === "emailToken") {
      serviceObject.tokens = user.services.emailToken.tokens;
      serviceObject.email = user.services.emailToken.email;
      fieldsToUnset["services.emailToken"] = 1;
    }

    newIdentity.service = {};
    newIdentity.service[identity.service] = serviceObject;

    const modifier = { $set: { identities: [newIdentity] } };
    if (Object.keys(fieldsToUnset).length > 0) {
      modifier.$unset = fieldsToUnset;
    }

    Meteor.users.update({ _id: user._id }, modifier);
  });
}

function repairEmailIdentityIds() {
  Meteor.users.find({ "identities.service.emailToken": { $exists: 1 } }).forEach(function (user) {
    if (user.identities.length != 1) {
      throw new Error("User does not have exactly one identity: ", user);
    }

    const identity = user.identities[0];
    const newIdentity = _.pick(identity, "main", "noLogin", "verifiedEmail", "unverifiedMail",
                               "profile");
    newIdentity.service = { email: identity.service.emailToken };
    newIdentity.id = Crypto.createHash("sha256")
      .update("email:" + identity.service.emailToken.email).digest("hex");

    Grains.update({ identityId: identity.id }, { $set: { identityId: newIdentity.id } }, { multi: true });
    Sessions.update({ identityId: identity.id }, { $set: { identityId: newIdentity.id } }, { multi: true });
    ApiTokens.update({ identityId: identity.id },
                     { $set: { identityId: newIdentity.id } },
                     { multi: true });
    ApiTokens.update({ "owner.user.identityId": identity.id },
                     { $set: { "owner.user.identityId": newIdentity.id } },
                     { multi: true });
    ApiTokens.update({ "owner.grain.introducerIdentity": identity.id },
                     { $set: { "owner.grain.introducerIdentity": newIdentity.id } },
                     { multi: true });

    while (ApiTokens.update({ "requirements.permissionsHeld.identityId": identity.id },
                            { $set: { "requirements.$.permissionsHeld.identityId": newIdentity.id } },
                            { multi: true }) > 0);

    Meteor.users.update({ _id: user._id }, { $set: { identities: [newIdentity] } });
  });
}

function splitAccountUsersAndIdentityUsers() {
  Meteor.users.find({ identities: { $exists: true } }).forEach(function (user) {
    if (user.identities.length != 1) {
      throw new Error("User does not have exactly one identity: ", user);
    }

    const identity = user.identities[0];
    const identityUser = _.pick(user, "createdAt", "lastActive", "expires");
    identityUser._id = identity.id;
    identityUser.profile = identity.profile;
    _.extend(identityUser, _.pick(identity, "unverifiedEmail"));
    identityUser.profile.service = Object.keys(identity.service)[0];

    // Updating this user needs to be a two step process because the `services` field typically
    // contains subfields that are constrained to be unique by Mongo indices.
    identityUser.stagedServices = _.omit(user.services, "resume");
    if (identity.service.dev) {
      identityUser.stagedServices.dev = identity.service.dev;
    } else if (identity.service.email) {
      identityUser.stagedServices.email = identity.service.email;
    }

    const accountUser = _.pick(user, "_id", "createdAt", "lastActive", "expires",
                             "isAdmin", "signupKey", "signupNote", "signupEmail",
                             "plan", "storageUsage", "isAppDemoUser", "appDemoId",
                             "payments", "dailySentMailCount", "hasCompletedSignup");
    accountUser.loginIdentities = [_.pick(identity, "id")];
    accountUser.nonloginIdentities = [];
    if (user.services && user.services.resume) {
      accountUser.services = { resume: user.services.resume };
    }

    accountUser.stashedOldUser = user;

    ApiTokens.update({ identityId: identityUser._id }, { $set: { accountId: user._id } },
                     { multi: true });

    Meteor.users.upsert({ _id: identityUser._id }, identityUser);
    Meteor.users.update({ _id: user._id }, accountUser);
  });

  Meteor.users.find({ stagedServices: { $exists: true } }).forEach(function (identity) {
    Meteor.users.update({ _id: identity._id }, { $unset: { stagedServices: 1 },
                                              $set: { services: identity.stagedServices }, });
  });
}

function populateContactsFromApiTokens() {
  ApiTokens.find({ "owner.user.identityId": { $exists: 1 },
                  accountId: { $exists: 1 }, }).forEach(function (token) {
    const identityId = token.owner.user.identityId;
    const identity = SandstormDb.prototype.getIdentity(identityId);
    if (identity) {
      const profile = identity.profile;
      Contacts.upsert({ ownerId: token.accountId, identityId: identityId }, {
        ownerId: token.accountId,
        petname: profile && profile.name,
        created: new Date(),
        identityId: identityId,
        profile: profile,
      });
    }
  });
}

function cleanUpApiTokens() {
  // The `splitUserIdsIntoAccountIdsAndIdentityIds()` migration only added `identityId` in cases
  // where the user still existed in the database.
  ApiTokens.remove({ userId: { $exists: true }, identityId: { $exists: false } });
  ApiTokens.remove({ "owner.user.userId": { $exists: true },
                    "owner.user.identityId": { $exists: false }, });

  // For a while we were accidentally setting `appIcon` instead of `icon`.
  ApiTokens.find({ "owner.user.denormalizedGrainMetadata.appIcon": { $exists: true } }).forEach(
      function (apiToken) {
    const icon = apiToken.owner.user.denormalizedGrainMetadata.appIcon;
    ApiTokens.update({ _id: apiToken._id },
                     { $set: { "owner.user.denormalizedGrainMetadata.icon": icon },
                      $unset: { "owner.user.denormalizedGrainMetadata.appIcon": true }, });
  });

  // For a while the `identityId` field of child UiView tokens was not getting set.
  function repairChain(parentToken) {
    ApiTokens.find({ parentToken: parentToken._id, grainId: { $exists: true },
                    identityId: { $exists: false }, }).forEach(function (childToken) {
      ApiTokens.update({ _id: childToken._id }, { $set: { identityId: parentToken.identityId } });
      repairChain(childToken);
    });
  }

  ApiTokens.find({ grainId: { $exists: true }, identityId: { $exists: true },
                  parentToken: { $exists: false }, }).forEach(repairChain);
}

function initServerTitleAndReturnAddress() {
  const hostname = Url.parse(process.env.ROOT_URL).hostname;
  Settings.insert({ _id: "serverTitle", value: hostname });
  Settings.insert({ _id: "returnAddress", value: "no-reply@" + hostname });
}

function sendReferralNotifications() {
  if (Meteor.settings.public.quotaEnabled) {
    Meteor.users.find({
      loginIdentities: { $exists: true },
      expires: { $exists: false },
    }, { fields: { _id: 1 } }).forEach(function (user) {
      sendReferralProgramNotification(user._id);
    });
  }
}

function assignBonuses() {
  if (Meteor.settings.public.quotaEnabled && SandstormDb.bonusesMigrationHook) {
    SandstormDb.bonusesMigrationHook();
  }
}

function splitSmtpUrl() {
  const smtpUrlSetting = Settings.findOne({ _id: "smtpUrl" });
  const smtpUrl = smtpUrlSetting ? smtpUrlSetting.value : process.env.MAIL_URL;
  const returnAddress = Settings.findOne({ _id: "returnAddress" });

  // Default values.
  const smtpConfig = {
    hostname: "localhost",
    port: "25",
    auth: undefined,
    returnAddress: returnAddress.value,
  };

  let parsed;
  try {
    parsed = smtpUrl && Url.parse(smtpUrl);
  } catch (e) {}

  if (parsed) {
    // If there was a SMTP URL previously defined, import its data.
    let auth = undefined;
    if (parsed.auth) {
      const colonIndex = parsed.auth.indexOf(":");
      let user = undefined;
      let pass = undefined;
      if (colonIndex !== -1) {
        user = parsed.auth.slice(0, colonIndex);
        pass = parsed.auth.slice(colonIndex + 1);
      }

      auth = {
        user,
        pass,
      };
    }

    // Override defaults with previous config's values.
    smtpConfig.hostname = parsed.hostname || "localhost";
    smtpConfig.port = parsed.port || "25";
    smtpConfig.auth = auth;
  }

  Settings.upsert({ _id: "smtpConfig" }, { value: smtpConfig });
  Settings.remove({ _id: "returnAddress" });
  Settings.remove({ _id: "smtpUrl" });
}

function smtpPortShouldBeNumber() {
  const entry = Settings.findOne({ _id: "smtpConfig" });
  if (entry) {
    const setting = entry.value;
    if (setting.port) {
      setting.port = _.isNumber(setting.port) ? setting.port : parseInt(setting.port);
      Settings.upsert({ _id: "smtpConfig" }, { value: setting });
    }
  }
}

function consolidateOrgSettings() {
  const orgGoogleDomain = Settings.findOne({ _id: "organizationGoogle" });
  const orgEmailDomain = Settings.findOne({ _id: "organizationEmail" });
  const orgLdap = Settings.findOne({ _id: "organizationLdap" });
  const orgSaml = Settings.findOne({ _id: "organizationSaml" });

  const orgMembership = {
    google: {
      enabled: orgGoogleDomain ? !!orgGoogleDomain.value : false,
      domain: orgGoogleDomain ? orgGoogleDomain.value : "",
    },
    email: {
      enabled: orgEmailDomain ? !!orgEmailDomain.value : false,
      domain: orgEmailDomain ? orgEmailDomain.value : "",
    },
    ldap: {
      enabled: orgLdap ? orgLdap.value : false,
    },
    saml: {
      enabled: orgSaml ? orgSaml.value : false,
    },
  };

  Settings.upsert({ _id: "organizationMembership" }, { value: orgMembership });
  Settings.remove({ _id: "organizationGoogle" });
  Settings.remove({ _id: "organizationEmail" });
  Settings.remove({ _id: "organizationLdap" });
  Settings.remove({ _id: "organizationSaml" });
}

function unsetSmtpDefaultHostnameIfNoUsersExist() {
  // We don't actually want to have the default hostname "localhost" set.
  // If the user has already finished configuring their server, then this migration should do
  // nothing (since we might break their deployment), but for new installs (which will have no users
  // at the time this migration runs) we'll unset the hostname if it's still the previously-filled
  // default value.
  const hasUsers = Meteor.users.findOne();
  if (!hasUsers) {
    const entry = Settings.findOne({ _id: "smtpConfig" });
    const smtpConfig = entry.value;
    if (smtpConfig.hostname === "localhost") {
      smtpConfig.hostname = "";
      Settings.upsert({ _id: "smtpConfig" }, { value: smtpConfig });
    }
  }
}

// This must come after all the functions named within are defined.
// Only append to this list!  Do not modify or remove list entries;
// doing so is likely change the meaning and semantics of user databases.
const MIGRATIONS = [
  updateLoginStyleToRedirect,
  enableLegacyOAuthProvidersIfNotInSettings,
  denormalizeInviteInfo,
  mergeRoleAssignmentsIntoApiTokens,
  fixOasisStorageUsageStats,
  fetchProfilePictures,
  assignPlans,
  removeKeyrings,
  useLocalizedTextInUserActions,
  verifyAllPgpSignatures,
  splitUserIdsIntoAccountIdsAndIdentityIds,
  appUpdateSettings,
  moveDevAndEmailLoginDataIntoIdentities,
  repairEmailIdentityIds,
  splitAccountUsersAndIdentityUsers,
  populateContactsFromApiTokens,
  cleanUpApiTokens,
  initServerTitleAndReturnAddress,
  sendReferralNotifications,
  assignBonuses,
  splitSmtpUrl,
  smtpPortShouldBeNumber,
  consolidateOrgSettings,
  unsetSmtpDefaultHostnameIfNoUsersExist,
];

function migrateToLatest() {
  if (Meteor.settings.replicaNumber) {
    // This is a replica. Wait for the first replica to perform migrations.

    console.log("Waiting for migrations on replica zero...");

    const done = new Future();
    const change = function (doc) {
      console.log("Migrations applied elsewhere: " + doc.value + "/" + MIGRATIONS.length);
      if (doc.value >= MIGRATIONS.length) done.return();
    };

    const observer = Migrations.find({ _id: "migrations_applied" }).observe({
      added: change,
      changed: change,
    });

    done.wait();
    observer.stop();
    console.log("Migrations have completed on replica zero.");

  } else {
    const applied = Migrations.findOne({ _id: "migrations_applied" });
    let start;
    if (!applied) {
      // Migrations table is not yet seeded with a value.  This means it has
      // applied 0 migrations.  Persist this.
      Migrations.insert({ _id: "migrations_applied", value: 0 });
      start = 0;
    } else {
      start = applied.value;
    }

    console.log("Migrations already applied: " + start + "/" + MIGRATIONS.length);

    for (let i = start; i < MIGRATIONS.length; i++) {
      // Apply migration i, then record that migration i was successfully run.
      console.log("Applying migration " + (i + 1));
      MIGRATIONS[i]();
      Migrations.update({ _id: "migrations_applied" }, { $set: { value: i + 1 } });
      console.log("Applied migration " + (i + 1));
    }
  }
}

SandstormDb.prototype.migrateToLatest = migrateToLatest;
