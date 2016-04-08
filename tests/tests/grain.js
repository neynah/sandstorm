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

'use strict';

var utils = require('../utils'),
    appDetailsTitleSelector = utils.appDetailsTitleSelector,
    actionSelector = utils.actionSelector,
    short_wait = utils.short_wait,
    medium_wait = utils.medium_wait,
    long_wait = utils.long_wait,
    very_long_wait = utils.very_long_wait;
var path = require('path');
var assetsPath = path.resolve(__dirname, '../assets');
var expectedHackerCMSButtonText = 'New Hacker CMS site';
var expectedHackerCMSGrainTitle = 'Untitled Hacker CMS site';
var expectedGitWebGrainTitle = 'Untitled GitWeb repository';

module.exports = utils.testAllLogins({
  // TODO(soon): Uploading tests are broken. Waiting on refactor of upload input to fix.
  // "Test local install" : function (browser) {
  //   browser
  //     .click('#upload-app-button')
  //     .ifDemo(function () {
  //       browser
  //         .waitForElementVisible('.upload-button', medium_wait)
  //         .assert.containsText('#uploadButton', 'Upload')
  //         .waitForElementVisible('#uploadButton', short_wait)
  //         .setValue('#uploadFile', path.join(assetsPath, 'ssjekyll6.spk'))
  //         .click('#uploadButton')
  //         // .waitForElementVisible('#upload p', medium_wait)
  //         // .assert.containsText('#upload p', 'Sorry, this server requires an invite before you can install apps.')
  //         .init()
  //         .waitForElementVisible('#applist-apps', medium_wait);
  //     })
  //     .ifNotDemo(function () {
  //       browser
  //         .waitForElementVisible('#uploadButton', medium_wait)
  //         .assert.containsText('#uploadButton', 'Upload')
  //         .waitForElementVisible('#uploadButton', short_wait)
  //         .setValue('#uploadFile', path.join(assetsPath, 'ssjekyll6.spk'))
  //         .click('#uploadButton')
  //         .waitForElementVisible('#step-confirm', long_wait)
  //         .click('#confirmInstall')
  //         .waitForElementVisible('.new-grain-button', short_wait)
  //         .assert.containsText('.new-grain-button', expectedHackerCMSButtonText);
  //     });
  // },

  // "Test upgrade" : function (browser) {
  //   browser
  //     .click("#applist-apps > ul > li:nth-child(1)")
  //     .waitForElementVisible('#upload-app-button', medium_wait)
  //     .click('#upload-app-button')
  //     .ifDemo(function () {
  //       browser
  //         .waitForElementVisible('#upload p', medium_wait)
  //         // .assert.containsText('#upload p', 'demo users are not allowed')
  //         .init()
  //         .waitForElementVisible('#applist-apps', medium_wait);
  //     })
  //     .ifNotDemo(function () {
  //       browser
  //         .waitForElementVisible('#uploadButton', medium_wait)
  //         .assert.containsText('#uploadButton', 'Upload')
  //         .waitForElementVisible('#uploadButton', short_wait)
  //         .setValue('#uploadFile', path.join(assetsPath, 'ssjekyll7.spk'))
  //         .click('#uploadButton')
  //         .waitForElementVisible('#step-confirm', long_wait)
  //         .assert.containsText('#confirmInstall', 'Upgrade')
  //         .click('#confirmInstall')
  //         .waitForElementVisible('.new-grain-button', short_wait)
  //         .assert.containsText('.new-grain-button', expectedHackerCMSButtonText);
  //     });
  // },

  // "Test downgrade" : function (browser) {
  //   browser
  //     .click("#applist-apps > ul > li:nth-child(1)")
  //     .waitForElementVisible('#upload-app-button', medium_wait)
  //     .click('#upload-app-button')
  //     .ifDemo(function () {
  //       browser
  //         .waitForElementVisible('#upload p', medium_wait)
  //         // .assert.containsText('#upload p', 'demo users are not allowed')
  //         .init()
  //         .waitForElementVisible('#applist-apps', medium_wait);
  //     })
  //     .ifNotDemo(function () {
  //       browser
  //         .waitForElementVisible('#uploadButton', medium_wait)
  //         .assert.containsText('#uploadButton', 'Upload')
  //         .waitForElementVisible('#uploadButton', short_wait)
  //         .setValue('#uploadFile', path.join(assetsPath, 'ssjekyll5.spk'))
  //         .click('#uploadButton')
  //         .waitForElementVisible('#step-confirm', long_wait)
  //         .assert.containsText('#confirmInstall', 'Downgrade')
  //         .click('#confirmInstall')
  //         .waitForElementVisible('.new-grain-button', short_wait)
  //         .assert.containsText('.new-grain-button', expectedHackerCMSButtonText);
  //     });
  // },

  "Test remote install" : function (browser) {
    browser
      .url(browser.launch_url + "/install/ca690ad886bf920026f8b876c19539c1?url=http://sandstorm.io/apps/ssjekyll8.spk")
      .disableGuidedTour()
      .waitForElementVisible('#step-confirm', very_long_wait)
      .click('#confirmInstall')
      .waitForElementVisible(appDetailsTitleSelector, short_wait)
      .assert.containsText(appDetailsTitleSelector, 'Hacker CMS');
  },

  "Test new grain" : function (browser) {
    browser
      .waitForElementVisible(actionSelector, short_wait)
      .click(actionSelector)
      .waitForElementVisible('#grainTitle', medium_wait)
      .assert.containsText('#grainTitle', expectedHackerCMSGrainTitle);
  },

  "Test grain frame" : function (browser) {
    browser
      .waitForElementPresent('iframe.grain-frame', short_wait)
      .frame('grain-frame')
        .waitForElementPresent('#publish', medium_wait)
        .assert.containsText('#publish', 'Publish')
      .frameParent();
  },

  "Test grain restart" : function (browser) {
    browser
      .click('#restartGrain')
      .pause(short_wait)
      .frame('grain-frame')
        .waitForElementPresent('#publish', medium_wait)
        .assert.containsText('#publish', 'Publish')
      .frameParent();
  },

  "Test grain debug" : function (browser) {
    browser
      .click('#openDebugLog')
      .pause(short_wait)
      .windowHandles(function (windows) {
        browser.switchWindow(windows.value[1]);
      })
      .pause(short_wait)
      .assert.containsText('.grainlog-title', 'Debug log: ' + expectedHackerCMSGrainTitle)
      .closeWindow()
      .end();
  },
});

module.exports["Test grain not found"] = function (browser) {
  browser
    .url(browser.launch_url + "/grain/BogusGrainId")
    .waitForElementVisible(".grain-not-found", medium_wait)
    .assert.containsText(".grain-not-found", "No grain found")
    .loginDevAccount()
    .url(browser.launch_url + "/grain/BogusGrainId")
    .waitForElementVisible(".grain-not-found", medium_wait)
    .assert.containsText(".grain-not-found", "No grain found")
    .end()
}

module.exports["Sign in at grain URL"] = function (browser) {
  browser
    .installApp("http://sandstorm.io/apps/ssjekyll8.spk", "ca690ad886bf920026f8b876c19539c1", "nqmcqs9spcdpmqyuxemf0tsgwn8awfvswc58wgk375g4u25xv6yh")
    .waitForElementVisible("#grainTitle", medium_wait)
    .assert.containsText("#grainTitle", expectedHackerCMSGrainTitle)
    .getDevName(function (devName) {
      browser
        .url(function (grainUrl) {
          browser
            .execute("window.Meteor.logout()")
            .url(browser.launch_url)
            .url(grainUrl.value)
            .waitForElementVisible(".request-access", medium_wait)
            .assert.containsText(".request-access", "Please sign in to request access.")
            .execute(function (name) { window.loginDevAccount(name) }, [devName.value])
            .waitForElementVisible("#grain-frame", medium_wait)
            .waitForElementVisible("#grainTitle", medium_wait)
            .assert.containsText("#grainTitle", expectedHackerCMSGrainTitle)
            .frame("grain-frame")
            .waitForElementPresent("#publish", medium_wait)
            .assert.containsText("#publish", "Publish")
            .frame(null)
            // Now try it with a /shared/ path.
            .click('.topbar .share > .show-popup')
            .waitForElementVisible('#shareable-link-tab-header', short_wait)
            .click('#shareable-link-tab-header')
            .waitForElementVisible(".new-share-token", short_wait)
            .submitForm('.new-share-token')
            .waitForElementVisible('#share-token-text', medium_wait)
            .getText('#share-token-text', function(response) {
              browser
                .execute("window.Meteor.logout()")
                .loginDevAccount(null, false, function (otherName) { // Generate a new user.
                  browser
                    .execute("window.Meteor.logout()")
                    .url(browser.launch_url)
                    .url(response.value)
                    .waitForElementVisible("#grain-frame", medium_wait)
                    .waitForElementVisible("#grainTitle", medium_wait)
                    .assert.containsText("#grainTitle", expectedHackerCMSGrainTitle)
                    .execute(function (name) { window.loginDevAccount(name) }, [otherName])

                    // It's unclear whether there should be an identity chooser here.
                    // See https://github.com/sandstorm-io/sandstorm/issues/1076
                    // .waitForElementVisible("button.pick-identity", medium_wait)
                    // .click("button.pick-identity")

                    .waitForElementNotPresent(".request-access", medium_wait)
                    // The forget grain button only appears once we've logged in.
                    .waitForElementVisible("#deleteGrain", medium_wait)
                    .waitForElementVisible("#grainTitle", medium_wait)
                    .waitForElementVisible("#grain-frame", medium_wait)
                    .assert.containsText("#grainTitle", expectedHackerCMSGrainTitle)
                    .frame("grain-frame")
                    .waitForElementPresent("#publish", medium_wait)
                    .assert.containsText("#publish", "Publish")
                    .frame(null)
                    .end()
                })
            });
        });
    });
}

module.exports["Logging out closes grain"] = function (browser) {
  browser
    .installApp("http://sandstorm.io/apps/ssjekyll8.spk", "ca690ad886bf920026f8b876c19539c1", "nqmcqs9spcdpmqyuxemf0tsgwn8awfvswc58wgk375g4u25xv6yh")
    .waitForElementVisible("#grainTitle", medium_wait)
    .assert.containsText("#grainTitle", expectedHackerCMSGrainTitle)
    .execute("window.Meteor.logout()")
    .waitForElementVisible(".request-access", medium_wait)
    .assert.containsText(".request-access", "Please sign in to request access.")
    .end()
}

module.exports["Test grain anonymous user"] = function (browser) {
  browser
    // Upload app as normal user
    .installApp("http://sandstorm.io/apps/ssjekyll8.spk", "ca690ad886bf920026f8b876c19539c1", "nqmcqs9spcdpmqyuxemf0tsgwn8awfvswc58wgk375g4u25xv6yh")
    .waitForElementVisible('#grainTitle', medium_wait)
    .assert.containsText('#grainTitle', expectedHackerCMSGrainTitle)
    .click('.topbar .share > .show-popup')
    .waitForElementVisible('#shareable-link-tab-header', short_wait)
    .click('#shareable-link-tab-header')
    .waitForElementVisible(".new-share-token", short_wait)
    .submitForm('.new-share-token')
    .waitForElementVisible('#share-token-text', medium_wait)
    // Navigate to the url with an anonymous user
    .getText('#share-token-text', function(response) {
      browser
        .executeAsync(function (done) {
          var handle = new Promise(function (resolve, reject) {
            window.Meteor.logout(function (err) {
              if (err) reject(err);
              resolve();
            });
          });
          handle.then(function () {
            done();
          });
        }, [])
        .url(response.value)
        .waitForElementVisible('#grainTitle', medium_wait)
        .assert.containsText('#grainTitle', expectedHackerCMSGrainTitle)
        .frame('grain-frame')
        .waitForElementPresent('#publish', medium_wait)
        .assert.containsText('#publish', 'Publish')
        .frame(null)
        .end();
    });
}

// Test roleless sharing between multiple users
module.exports["Test roleless sharing"] = function (browser) {
  var firstUserName;
  var secondUserName;
  browser
  // Upload app as 1st user
    .installApp("http://sandstorm.io/apps/ssjekyll8.spk", "ca690ad886bf920026f8b876c19539c1", "nqmcqs9spcdpmqyuxemf0tsgwn8awfvswc58wgk375g4u25xv6yh")
    .getDevName(function (result) {
      firstUserName = result.value;
    })
    .waitForElementVisible('.grain-frame', medium_wait)
    .assert.containsText('#grainTitle', expectedHackerCMSGrainTitle)
    .click('.topbar .share > .show-popup')
    .waitForElementVisible("#shareable-link-tab-header", short_wait)
    .click("#shareable-link-tab-header")
    .waitForElementVisible(".new-share-token", short_wait)
    .submitForm('.new-share-token')
    .waitForElementVisible('#share-token-text', medium_wait)
    // Navigate to the url with 2nd user
    .getText('#share-token-text', function(response) {
      browser
        .loginDevAccount()
        .getDevName(function(result) {
          secondUserName = result.value;
        })
        .url(response.value)
        .waitForElementVisible("button.pick-identity", short_wait)
        .click("button.pick-identity")
        .waitForElementVisible('.grain-frame', medium_wait)
        .assert.containsText('#grainTitle', expectedHackerCMSGrainTitle)
        .frame('grain-frame')
        .waitForElementPresent('#publish', medium_wait)
        .assert.containsText('#publish', 'Publish')
        .frame(null)
        .click('.topbar .share > .show-popup')
        .waitForElementVisible("#shareable-link-tab-header", short_wait)
        .click("#shareable-link-tab-header")
        .waitForElementVisible(".new-share-token", short_wait)
        .submitForm('.new-share-token')
        .waitForElementVisible('#share-token-text', medium_wait)
        // Navigate to the re-shared url with 3rd user
        .getText('#share-token-text', function(response) {
          browser
            .loginDevAccount()
            .url(response.value)
            .waitForElementVisible("button.pick-identity", short_wait)
            .click("button.pick-identity")
            .waitForElementVisible('.grain-frame', medium_wait)
            .assert.containsText('#grainTitle', expectedHackerCMSGrainTitle)
            .frame('grain-frame')
            .waitForElementPresent('#publish', medium_wait)
            .assert.containsText('#publish', 'Publish')
            .frame(null)
            .click('.topbar .share > .show-popup')
            .waitForElementVisible("#shareable-link-tab-header", short_wait)
            .click("#shareable-link-tab-header")
            .waitForElementVisible(".new-share-token", short_wait)
            .submitForm('.new-share-token')
            .waitForElementVisible('#share-token-text', medium_wait)

            .loginDevAccount(firstUserName)
            .url(response.value)
            .waitForElementVisible('.grain-frame', medium_wait)
            .assert.containsText('#grainTitle', expectedHackerCMSGrainTitle)
            .click('.topbar .share > .show-popup')
            .click('.popup.share .who-has-access')
            .waitForElementVisible('.popup.who-has-access', medium_wait)
            .waitForElementVisible('.popup.who-has-access .people td', medium_wait)
            .assert.containsText('.popup.who-has-access .people td', secondUserName)
            .end();
        });
    });
}

// Test sharing between multiple users. The users here are different from those in the
// "Test roleless sharing" case to ensure that the incognito interstitial always appears.
module.exports["Test role sharing"] = function (browser) {
  browser
    // Upload app as 1st user
    .installApp("http://sandstorm.io/apps/david/gitweb5.spk",
                "26eb486a44085512a678c543fc7c1fdd",
                "6va4cjamc21j0znf5h5rrgnv0rpyvh1vaxurkrgknefvj0x63ash")
    .waitForElementVisible('.grain-frame', medium_wait)
    .assert.containsText('#grainTitle', expectedGitWebGrainTitle)
    .click('.topbar .share > .show-popup')
    .waitForElementVisible("#shareable-link-tab-header", short_wait)
    .click("#shareable-link-tab-header")
    .waitForElementVisible("#shareable-link-tab .share-token-role", medium_wait)
    .assert.valueContains("#shareable-link-tab .share-token-role", "can read and write")
    .submitForm('.new-share-token')
    .waitForElementVisible('#share-token-text', medium_wait)
     // Navigate to the url with 2nd user
    .getText('#share-token-text', function(response) {
      browser
        .loginDevAccount()
        .url(response.value)
        .waitForElementVisible("button.pick-identity", short_wait)
        .click("button.pick-identity")
        .waitForElementVisible('.grain-frame', medium_wait)
        .assert.containsText('#grainTitle', expectedGitWebGrainTitle)
        .frame('grain-frame')
        .waitForElementPresent('#offer-iframe', medium_wait) // Wait for GitWeb's offer iframe.
        .frame(null)
        .click('.topbar .share > .show-popup')
        .waitForElementVisible("#shareable-link-tab-header", short_wait)
        .click("#shareable-link-tab-header")
        .waitForElementVisible("#shareable-link-tab .share-token-role", medium_wait)
        .assert.valueContains("#shareable-link-tab .share-token-role", "can read and write")
        .submitForm('.new-share-token')
        .waitForElementVisible('#share-token-text', medium_wait)
        // Navigate to the re-shared url with 3rd user
        .getText('#share-token-text', function(response) {
          browser
            .loginDevAccount()
            .url(response.value)
            .waitForElementVisible("button.pick-identity", short_wait)
            .click("button.pick-identity")
            .waitForElementVisible('.grain-frame', medium_wait)
            .assert.containsText('#grainTitle', expectedGitWebGrainTitle)
            .frame('grain-frame')
            .waitForElementPresent('#offer-iframe', medium_wait) // Wait for GitWeb's offer iframe.
            .frame(null)
            .click('.topbar .share > .show-popup')
            .waitForElementVisible("#shareable-link-tab-header", short_wait)
            .click("#shareable-link-tab-header")
            .waitForElementVisible("#shareable-link-tab .share-token-role", medium_wait)
            .assert.valueContains("#shareable-link-tab .share-token-role", "can read and write")
            .submitForm('.new-share-token')
            .waitForElementVisible('#share-token-text', medium_wait)
            .end();
        });
    });
}

module.exports["Test grain identity chooser interstitial"] = function (browser) {
  browser
    // Upload app as normal user
    .installApp("http://sandstorm.io/apps/ssjekyll8.spk", "ca690ad886bf920026f8b876c19539c1", "nqmcqs9spcdpmqyuxemf0tsgwn8awfvswc58wgk375g4u25xv6yh")
    .waitForElementVisible('.grain-frame', medium_wait)
    .assert.containsText('#grainTitle', expectedHackerCMSGrainTitle)
    .click('.topbar .share > .show-popup')
    .waitForElementVisible("#shareable-link-tab-header", short_wait)
    .click("#shareable-link-tab-header")
    .waitForElementVisible(".new-share-token", short_wait)
    .submitForm('.new-share-token')
    .waitForElementVisible('#share-token-text', medium_wait)
    .getText('#share-token-text', function(shareLink) {
      browser
        .url(shareLink.value)
         // Identity picker should not come up on visiting our own link.
        .url(shareLink.value)
        .waitForElementVisible('.grain-frame', medium_wait)
        .assert.containsText('#grainTitle', expectedHackerCMSGrainTitle)
        .frame('grain-frame')
        .waitForElementPresent('#publish', medium_wait)
        .assert.containsText('#publish', 'Publish')
        .frame(null)

        // Navigate to the url with an anonymous user
        .loginDevAccount()
        .pause(short_wait)
        // Try incognito
        .url(shareLink.value)
        .waitForElementVisible(".incognito-button", short_wait)
        .click(".incognito-button")
        .waitForElementVisible('.grain-frame', medium_wait)
        .assert.containsText('#grainTitle', expectedHackerCMSGrainTitle)
        .execute(function() {
          return Accounts.getCurrentIdentityId();
        }, [], function (response) {
          browser.assert.equal(response.value, null);
        })
        .frame('grain-frame')
        .waitForElementPresent('#publish', medium_wait)
        .assert.containsText('#publish', 'Publish')
        // Try redeeming as current user
        // TODO(someday): pick a better app that shows off the different userid/username
        .frame(null)
        .click(".topbar .share > .show-popup")
        .waitForElementVisible('a.open-non-anonymously', short_wait)
        .click("a.open-non-anonymously")
        .waitForElementVisible("button.pick-identity", short_wait)
        .click("button.pick-identity")
        .waitForElementVisible('.grain-frame', medium_wait)
        .assert.containsText('#grainTitle', expectedHackerCMSGrainTitle)
        .frame('grain-frame')
        .waitForElementPresent('#publish', medium_wait)
        .assert.containsText('#publish', 'Publish')
        .frame(null)

         // Identity picker should not come up on reloading the page.
        .url(shareLink.value)
        .waitForElementVisible('.grain-frame', medium_wait)
        .assert.containsText('#grainTitle', expectedHackerCMSGrainTitle)
        .execute(function() {
          return Accounts.getCurrentIdentityId();
        }, [], function (response) {
          browser.assert.equal(!!response.value, true);
        })
        .frame('grain-frame')
        .waitForElementPresent('#publish', medium_wait)
        .assert.containsText('#publish', 'Publish')
        .frame(null)

        .click('.topbar .share > .show-popup')
        .waitForElementVisible("#shareable-link-tab-header", short_wait)
        .click("#shareable-link-tab-header")
        .waitForElementVisible(".new-share-token", short_wait)
        .submitForm('.new-share-token')
        .waitForElementVisible('#share-token-text', medium_wait)
        .getText('#share-token-text', function(shareLink) {
          browser
            .url(shareLink.value)
             // Identity picker should not come up on visiting our own link.
            .url(shareLink.value)
            .waitForElementVisible('.grain-frame', medium_wait)
            .assert.containsText('#grainTitle', expectedHackerCMSGrainTitle)
            .frame('grain-frame')
            .waitForElementPresent('#publish', medium_wait)
            .assert.containsText('#publish', 'Publish')
            .frame(null)
            .end()
        });
    });
}
