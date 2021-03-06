/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const crypto = require('crypto');

const assert = require('insist');
const buf = require('buf').hex;
const hex = require('buf').to.hex;

const encrypt = require('../../lib/encrypt');
const db = require('../../lib/db');
const config = require('../../lib/config');
const auth = require('../../lib/auth');
const Promise = require('bluebird');

/*global describe,it,before*/

function randomString(len) {
  return crypto.randomBytes(Math.ceil(len)).toString('hex');
}

describe('db', function() {

  describe('#_initialClients', function() {
    it('should not insert already existing clients', function() {
      return db.ping().then(function() {
        return db._initialClients();
      });
    });

    it('should update existing clients', function() {
      var clients = config.get('clients');
      return db.ping().then(function() {
        clients[0].imageUri = 'http://other.domain/foo/bar.png';
        config.set('clients', clients);
        return db._initialClients();
      }).then(function() {
        return db.getClient(clients[0].id);
      }).then(function(c) {
        assert.equal(c.imageUri, clients[0].imageUri);
      });
    });
  });

  describe('utf-8', function() {

    function makeTest(clientId, clientName) {
      return function() {
        var data = {
          id: clientId,
          name: clientName,
          hashedSecret: randomString(32),
          imageUri: 'https://example.domain/logo',
          redirectUri: 'https://example.domain/return?foo=bar',
          trusted: true
        };

        return db.registerClient(data)
          .then(function(c) {
            assert.equal(c.id.toString('hex'), clientId);
            assert.equal(c.name, clientName);
            return db.getClient(c.id);
          })
          .then(function(cli) {
            assert.equal(cli.id.toString('hex'), clientId);
            assert.equal(cli.name, clientName);
            return db.removeClient(clientId);
          })
          .then(function() {
            return db.getClient(clientId)
              .then(function(cli) {
                assert.equal(void 0, cli);
              });
          });
      };
    }

    it('2-byte encoding preserved', makeTest(randomString(8), 'Düsseldorf'));
    it('3-byte encoding preserved', makeTest(randomString(8), '北京')); // Beijing
    it('4-byte encoding throws with mysql; ok with memdb', function() {
      var data = {
        id: randomString(8),
        // 'MUSICAL SYMBOL F CLEF' (U+1D122) (JS: '\uD834\uDD22', UTF8: '0xF0 0x9D 0x84 0xA2')
        // http://www.fileformat.info/info/unicode/char/1d122/index.htm
        name: '𝄢',
        hashedSecret: randomString(32),
        imageUri: 'https://example.domain/logo',
        redirectUri: 'https://example.domain/return?foo=bar',
        trusted: true
      };

      return db.registerClient(data)
        .then(function(c) {
          if (config.get('db.driver') === 'memory') {
            assert.ok(c.name === data.name, '4-byte UTF8 works with memory db');
          } else {
            assert.fail('This should not have succeeded.');
          }
        })
        .catch(function(err) {
          if (config.get('db.driver') === 'memory') {
            assert.fail('This should not have failed.');
          } else {
            assert.ok(err);
            assert.equal(err.code, 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD');
            assert.equal(err.errno, 1366);
          }
        });
    });
  });

  describe('getEncodingInfo', function() {
    it('should use utf8', function() {
      if (config.get('db.driver') === 'memory') {
        return assert.ok('getEncodingInfo has no meaning with memory impl');
      }

      return db.getEncodingInfo()
        .then(function(info) {
          assert.equal(info['character_set_connection'], 'utf8mb4');
          assert.equal(info['character_set_database'], 'utf8');
          assert.equal(info['collation_connection'], 'utf8mb4_unicode_ci');
          assert.equal(info['collation_database'], 'utf8_unicode_ci');
        });
    });
  });

  if (config.get('db.driver') === 'mysql') {
    describe('purgeExpiredTokens', function () {
      var clientIdA;
      var clientIdB;
      var userId;
      var email;


      function seedTokens (client, userId, email, count, expiresAt) {
        var accessTokens = [];
        for (var i = 0; i < count; i++) {
          accessTokens.push({
            clientId: buf(client),
            userId: buf(userId),
            email: email,
            scope: [auth.SCOPE_CLIENT_MANAGEMENT],
            expiresAt: expiresAt
          });
        }

        return Promise.each(accessTokens, function (options) {
          return db.generateAccessToken(options);
        });
      }

      // Inserts 2000 access tokens with the following breakdown
      // ClientIdA - 500 expired, 500 valid
      // ClientIdB - 500 expired, 500 valid
      before('setup clients', function(){
        email = 'asdf@asdf.com';
        clientIdA = randomString(8);
        clientIdB = randomString(8);
        userId = buf(randomString(16));

        return db.registerClient({
          id: clientIdA,
          name: 'ClientA',
          hashedSecret: randomString(32),
          imageUri: 'https://example.domain/logo',
          redirectUri: 'https://example.domain/return?foo=bar',
          trusted: true
        })
        .then( function () {
          return db.registerClient({
            id: clientIdB,
            name: 'ClientB',
            hashedSecret: randomString(32),
            imageUri: 'https://example.domain/logo',
            redirectUri: 'https://example.domain/return?foo=bar',
            trusted: true
          });
        });
      });

      beforeEach('seed with tokens', function () {
        return db._write('DELETE FROM tokens;')
          .then( function () {
            return seedTokens(clientIdA, userId, email, 500);
          })
          .then( function () {
            return seedTokens(clientIdB, userId, email, 500);
          })
          .then( function () {
            return seedTokens(clientIdA, userId, email, 500, new Date(Date.now() - (1000 * 600)));
          })
          .then( function () {
            return seedTokens(clientIdB, userId, email, 500, new Date(Date.now() - (1000 * 600)));
          });
      });

      it('should fail purgeExpiredTokens without ignoreClientId', function() {
        return db.purgeExpiredTokens(1000, 5)
          .then( function () {
            assert.fail('purgeExpiredTokens() should fail with an empty ignoreClientId');
          })
          .catch( function (error) {
            assert.equal(error.message, 'empty ignoreClientId');
          });
      });

      it('should fail purgeExpiredTokens with an unknown ignoreClientId', function() {
        var unknownClientId = 'deadbeefdeadbeef';
        return db.purgeExpiredTokens(1000, 5, unknownClientId)
          .then( function () {
            assert.fail('purgeExpiredTokens() should fail with an unknown ignoreClientId');
          })
          .catch( function (error) {
            assert.equal(error.message, 'unknown ignoreClientId ' + unknownClientId);
          });
      });

      it('should call purgeExpiredTokens and ignore client', function() {
        return db.purgeExpiredTokens(1000, 0, clientIdA)
          .then( function () {
            // Check clientA tokens not deleted
            return db._read('SELECT COUNT(*) AS count FROM fxa_oauth.tokens WHERE clientId=UNHEX(?);', [
              clientIdA
            ]);
          })
          .then( function (result) {
            assert.equal(result[0].count, 1000);
          })
          .then( function () {
            // Check clientB expired tokens are deleted
            return db._read('SELECT COUNT(*) AS count FROM fxa_oauth.tokens WHERE clientId=UNHEX(?) AND expiresAt < NOW();', [
              clientIdB
            ]);
          })
          .then( function (result) {
            assert.equal(result[0].count, 0);
          })
          .then( function () {
            // Check clientB unexpired tokens are not deleted
            return db._read('SELECT COUNT(*) AS count FROM fxa_oauth.tokens WHERE clientId=UNHEX(?) AND expiresAt > NOW();', [
              clientIdB
            ]);
          })
          .then( function (result) {
            assert.equal(result[0].count, 500);
          })
          .then( function () {
            // Check the total tokens
            return db._read('SELECT COUNT(*) AS count FROM fxa_oauth.tokens;');
          })
          .then( function (result) {
            assert.equal(result[0].count, 1500);
          });
      });

      it('should call purgeExpiredTokens and only purge 100 items', function() {
        return db.purgeExpiredTokens(100, 0, clientIdA)
          .then( function () {
            // Check clientA tokens not deleted
            return db._read('SELECT COUNT(*) AS count FROM fxa_oauth.tokens WHERE clientId=UNHEX(?);', [
              clientIdA
            ]);
          })
          .then( function (result) {
            assert.equal(result[0].count, 1000);
          })
          .then( function () {
            // Check clientB only 100 expired tokens are deleted
            return db._read('SELECT COUNT(*) AS count FROM fxa_oauth.tokens WHERE clientId=UNHEX(?) AND expiresAt < NOW();', [
              clientIdB
            ]);
          })
          .then( function (result) {
            assert.equal(result[0].count, 400);
          })
          .then( function () {
            // Check clientB unexpired tokens are not deleted
            return db._read('SELECT COUNT(*) AS count FROM fxa_oauth.tokens WHERE clientId=UNHEX(?) AND expiresAt > NOW();', [
              clientIdB
            ]);
          })
          .then( function (result) {
            assert.equal(result[0].count, 500);
          })
          .then( function () {
            // Check the total tokens
            return db._read('SELECT COUNT(*) AS count FROM fxa_oauth.tokens;');
          })
          .then( function (result) {
            assert.equal(result[0].count, 1900);
          });
      });

      it('should call purgeExpiredTokens and ignore both clients as requested', function() {
        return db.purgeExpiredTokens(1000, 0, [ clientIdA, clientIdB ])
          .then( function () {
            // Check clientA tokens not deleted
            return db._read('SELECT COUNT(*) AS count FROM fxa_oauth.tokens WHERE clientId=UNHEX(?)', [
              clientIdA
            ]);
          })
          .then( function (result) {
            assert.equal(result[0].count, 1000);
          })
          .then( function () {
            // Check clientB expired tokens are not deleted
            return db._read('SELECT COUNT(*) AS count FROM fxa_oauth.tokens WHERE clientId=UNHEX(?)', [
              clientIdB
            ]);
          })
          .then( function (result) {
            assert.equal(result[0].count, 1000);
          })
          .then( function () {
            // Check the total tokens
            return db._read('SELECT COUNT(*) AS count FROM fxa_oauth.tokens');
          })
          .then( function (result) {
            assert.equal(result[0].count, 2000);
          });
      });
    });
  }

  describe('removeUser', function () {
    var clientId = buf(randomString(8));
    var userId = buf(randomString(16));
    var email = 'a@b.c';
    var scope = ['no-scope'];
    var code = null;
    var token = null;
    var refreshToken = null;

    before(function() {
      return db.registerClient({
        id: clientId,
        name: 'removeUserTest',
        hashedSecret: randomString(32),
        imageUri: 'https://example.domain/logo',
        redirectUri: 'https://example.domain/return?foo=bar',
        trusted: true
      }).then(function () {
        return db.generateCode({
          clientId: clientId,
          userId: userId,
          email: email,
          scope: scope,
          authAt: 0
        });
      }).then(function (c) {
        code = c;
        return db.getCode(code);
      }).then(function(code) {
        assert.equal(hex(code.userId), hex(userId));
        return db.generateAccessToken({
          clientId: clientId,
          userId: userId,
          email: email,
          scope: scope
        });
      }).then(function (t) {
        token = t.token;
        assert.equal(hex(t.userId), hex(userId), 'token userId');
        return db.generateRefreshToken({
          clientId: clientId,
          userId: userId,
          email: email,
          scope: scope
        });
      }).then(function (t) {
        refreshToken = t.token;
        assert.equal(hex(t.userId), hex(userId), 'token userId');
      });
    });

    it('should get the right refreshToken', function (){
      var hash = encrypt.hash(refreshToken);
      return db.getRefreshToken(hash).then(function(t) {
        assert.equal(hex(t.token), hex(hash), 'got the right refresh_token');
      });
    });

    it('should delete tokens and codes for the given userId', function () {
      return db.removeUser(userId).then(function () {
        return db.getCode(code);
      }).then(function (c) {
        assert.equal(c, undefined, 'code deleted');
        return db.getAccessToken(token);
      }).then(function (t) {
        assert.equal(t, undefined, 'token deleted');
        return db.getRefreshToken(encrypt.hash(refreshToken));
      }).then(function (t) {
        assert.equal(t, undefined, 'refresh_token deleted');
      });
    });
  });

  describe('refresh token lastUsedAt', function () {
    var clientId = buf(randomString(8));
    var userId = buf(randomString(16));
    var email = 'a@b.c';
    var scope = ['no-scope'];
    var code = null;
    var refreshToken = null;

    beforeEach(function() {
      return db.registerClient({
        id: clientId,
        name: 'lastUsedAtTest',
        hashedSecret: randomString(32),
        imageUri: 'https://example.domain/logo',
        redirectUri: 'https://example.domain/return?foo=bar',
        trusted: true
      }).then(function () {
        return db.generateCode({
          clientId: clientId,
          userId: userId,
          email: email,
          scope: scope,
          authAt: 0
        });
      }).then(function (c) {
        code = c;
        return db.getCode(code);
      }).then(function(code) {
        assert.equal(hex(code.userId), hex(userId));
        return db.generateAccessToken({
          clientId: clientId,
          userId: userId,
          email: email,
          scope: scope
        });
      }).then(function (t) {
        assert.equal(hex(t.userId), hex(userId), 'token userId');
        return db.generateRefreshToken({
          clientId: clientId,
          userId: userId,
          email: email,
          scope: scope
        });
      }).then(function (t) {
        refreshToken = t;
      });
    });

    it('should refresh token lastUsedAt', function () {
      var tokenFirstUsage = {};
      var hash = encrypt.hash(refreshToken.token);

      return db.getRefreshToken(hash).then(function (t) {
        assert.equal(hex(t.token), hex(hash), 'same token');

        tokenFirstUsage.createdAt = new Date(t.createdAt);
        tokenFirstUsage.lastUsedAt = t.lastUsedAt;

        return Promise.delay(1000); //ensures that creation and subsequent usage are at least 1s apart
      }).then(function() {
        return db.usedRefreshToken(encrypt.hash(refreshToken.token));
      }).then(function() {
        return db.getRefreshToken(hash);
      })
      .then(function(t) {
        assert.equal(hex(t.token), hex(hash), 'same token');
        var updatedLastUsedAt = new Date(t.lastUsedAt);

        assert.equal(updatedLastUsedAt > tokenFirstUsage.lastUsedAt, true, 'createdAt was updated');
        assert.equal(t.createdAt.toString(), tokenFirstUsage.createdAt.toString(), 'creation date not changed');
      });
    });
  });

  describe('client-tokens', function () {

    describe('getActiveClientTokensByUid', function() {
      var userId = buf(randomString(16));

      it('should return the active clients', function() {
        return db.getActiveClientTokensByUid(userId)
          .then(
            function(result) {
              assert.equal(result.length, 0);
            },
            function(err) {
              assert.fail(err);
            }
          );
      });
    });

    describe('deleteActiveClientTokens', function() {
      var clientId = buf(randomString(8));
      var userId = buf(randomString(16));

      it('should delete client tokens', function() {
        return db.deleteActiveClientTokens(clientId, userId)
          .then(
            function(result) {
              assert.ok(result);
            },
            function(err) {
              assert.fail(err);
            }
          );
      });
    });
  });

  describe('developers', function () {

    describe('removeDeveloper', function() {
      it('should not fail on non-existent developers', function() {
        return db.removeDeveloper('unknown@developer.com');
      });

      it('should delete developers', function() {
        var email = 'email' + randomString(10) + '@mozilla.com';

        return db.activateDeveloper(email)
          .then(function(developer) {
            assert.equal(developer.email, email);

            return db.removeDeveloper(email);
          })
          .then(function() {
            return db.getDeveloper(email);
          })
          .done(function(developer) {
            assert.equal(developer, null);
          });
      });
    });

    describe('getDeveloper', function() {
      it('should return null if developer does not exit', function() {
        return db.getDeveloper('unknown@developer.com')
          .then(function(developer) {
            assert.equal(developer, null);
          });
      });

      it('should throw on empty email', function() {
        return db.getDeveloper()
          .done(
          assert.fail,
          function(err) {
            assert.equal(err.message, 'Email is required');
          }
        );
      });

    });

    describe('activateDeveloper and getDeveloper', function() {
      it('should create developers', function() {
        var email = 'email' + randomString(10) + '@mozilla.com';

        return db.activateDeveloper(email)
          .done(function(developer) {
            assert.equal(developer.email, email);
          });
      });

      it('should not allow duplicates', function() {
        var email = 'email' + randomString(10) + '@mozilla.com';

        return db.activateDeveloper(email)
          .then(function() {
            return db.activateDeveloper(email);
          })
          .done(
            function() {
              assert.fail();
            },
            function(err) {
              assert.equal(err.message.indexOf('ER_DUP_ENTRY') >= 0, true);
            }
          );
      });

      it('should throw on empty email', function() {
        return db.activateDeveloper()
          .done(
            assert.fail,
            function(err) {
              assert.equal(err.message, 'Email is required');
            }
          );
      });

    });

    describe('registerClientDeveloper and developerOwnsClient', function() {
      var clientId = buf(randomString(8));
      var userId = buf(randomString(16));
      var email = 'a@b.c';
      var scope = ['no-scope'];
      var code = null;

      before(function() {
        return db.registerClient({
          id: clientId,
          name: 'registerClientDeveloper',
          hashedSecret: randomString(32),
          imageUri: 'https://example.domain/logo',
          redirectUri: 'https://example.domain/return?foo=bar',
          trusted: true
        }).then(function() {
          return db.generateCode({
            clientId: clientId,
            userId: userId,
            email: email,
            scope: scope,
            authAt: 0
          });
        }).then(function(c) {
          code = c;
          return db.getCode(code);
        }).then(function(code) {
          assert.equal(hex(code.userId), hex(userId));
          return db.generateAccessToken({
            clientId: clientId,
            userId: userId,
            email: email,
            scope: scope
          });
        }).then(function(t) {
          assert.equal(hex(t.userId), hex(userId), 'token userId');
        });
      });

      it('should attach a developer to a client', function(done) {
        var email = 'email' + randomString(10) + '@mozilla.com';

        return db.activateDeveloper(email)
          .then(function(developer) {
            return db.registerClientDeveloper(
              hex(developer.developerId),
              hex(clientId)
            );
          })
          .then(function() {
            return db.getClientDevelopers(hex(clientId));
          })
          .done(function(developers) {
            if (developers) {
              var found = false;

              developers.forEach(function(developer) {
                if (developer.email === email) {
                  found = true;
                }
              });

              assert.equal(found, true);
              return done();
            }
          }, done);

      });

    });

  });

});
