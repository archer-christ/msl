/**
 * Copyright (c) 2012-2018 Netflix, Inc.  All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * <p>A message builder provides methods for building messages.</p>
 *
 * @author Wesley Miaw <wmiaw@netflix.com>
 */
(function(require, module) {
	"use strict";

	var MslConstants = require('../MslConstants.js');
	var MslInternalException = require('../MslInternalException.js');
	var AsyncExecutor = require('../util/AsyncExecutor.js');
	var MslKeyExchangeException = require('../MslKeyExchangeException.js');
	var MslError = require('../MslError.js');
	var MslException = require('../MslException.js');
	var MslUserAuthException = require('../MslUserAuthException.js');
	var MessageCapabilities = require('../msg/MessageCapabilities.js');
	var ErrorHeader = require('../msg/ErrorHeader.js');
	var Class = require('../util/Class.js');
	var MslMessageException = require('../MslMessageException.js');
	var MessageHeader = require('../msg/MessageHeader.js');
	var ServiceToken = require('../tokens/ServiceToken.js');
	var NullCryptoContext = require('../crypto/NullCryptoContext.js');
	var MslUtils = require('../util/MslUtils.js');

    /**
     * Empty service token data.
     * @const
     * @type {Uint8Array}
     */
    var EMPTY_DATA = new Uint8Array(0);

    /**
     * Increments the provided message ID by 1, wrapping around to zero if
     * the provided value is equal to {@link MslConstants.MAX_LONG_VALUE}.
     *
     * @param {number} messageId the message ID to increment.
     * @return {number} the message ID + 1.
     * @throws MslInternalException if the provided message ID is out of range.
     */
    var MessageBuilder$incrementMessageId = function MessageBuilder$incrementMessageId(messageId) {
        if (messageId < 0 || messageId > MslConstants.MAX_LONG_VALUE)
            throw new MslInternalException("Message ID " + messageId + " is outside the valid range.");
        return (messageId == MslConstants.MAX_LONG_VALUE) ? 0 : messageId + 1;
    };

    /**
     * Decrements the provided message ID by 1, wrapping around to
     * {@link MslConstants.MAX_LONG_VALUE} if the provided value is equal to 0.
     *
     * @param {number} messageId the message ID to decrement.
     * @return {number} the message ID - 1.
     * @throws MslInternalException if the provided message ID is out of range.
     */
    var MessageBuilder$decrementMessageId = function MessageBuilder$decrementMessageId(messageId) {
        if (messageId < 0 || messageId > MslConstants.MAX_LONG_VALUE)
            throw new MslInternalException("Message ID " + messageId + " is outside the valid range.");
        return (messageId == 0) ? MslConstants.MAX_LONG_VALUE : messageId - 1;
    };

    var MessageBuilder = module.exports = Class.create({
        /**
         * <p>Create a new message builder that will craft a new message. If a
         * message ID is provided it will be used for the new message's message ID.
         * Otherwise a random message ID will be generated.</p>
         *
         * @param {MslContext} ctx MSL context.
         * @param {MasterToken} masterToken master token. May be null unless a user ID token is
         *        provided.
         * @param {UserIdToken} userIdToken user ID token. May be null.
         * @param {?number} messageId the message ID to use. Must be within range.
         * @param {{result: function(MessageBuilder), error: function(Error)}}
         *        callback the callback that will receive the message builder or
         *        any thrown exceptions.
         * @throws MslException if a user ID token is not bound to its
         *         corresponding master token.
         */
        init: function init(ctx, masterToken, userIdToken, messageId, callback) {
            var self = this;
            AsyncExecutor(callback, function() {
                if (messageId == undefined || messageId == null) {
                    messageId = MslUtils.getRandomLong(ctx);
                } else {
                    if (messageId < 0 || messageId > MslConstants.MAX_LONG_VALUE)
                        throw new MslInternalException("Message ID " + messageId + " is outside the valid range.");
                }

                // Grab the local entity authentication data.
                ctx.getEntityAuthenticationData(null, {
                    result: function(entityAuthData) {
                        AsyncExecutor(callback, function() {
                            var capabilities = ctx.getMessageCapabilities();
                            this.initializeMessageBuilder(ctx, messageId, capabilities, entityAuthData, masterToken, userIdToken, null, null, null, null, null);
                            return this;
                        }, self);
                    },
                    error: callback.error,
                });
            }, self);
        },

        /**
         * initialize a message builder with the provided tokens and key exchange
         * data if a master token was issued or renewed.
         *
         * @param {MslContext} ctx MSL context.
         * @param {number} messageId message ID.
         * @param {MessageCapabilities} message capabilities.
         * @param {EntityAuthenticationData} entityAuthData entity
         *        authentication data.
         * @param {MasterToken} masterToken master token. May be null unless a user ID token is
         *        provided.
         * @param {UserIdToken} userIdToken user ID token. May be null.
         * @param {Array.<ServiceToken>} serviceTokens initial set of service tokens. May be null.
         * @param {MasterToken} peerMasterToken peer master token. May be null unless a peer user
         *        ID token is provided.
         * @param {UserIdToken} peerUserIdToken peer user ID token. May be null.
         * @param {Array.<ServiceToken>} peerServiceTokens initial set of peer service tokens.
         *        May be null.
         * @param {KeyExchangeData} keyExchangeData key exchange data. May be null.
         * @param {{result: function(MessageBuilder), error: function(Error)}}
         *        callback the callback that will receive this message builder
         *        or any thrown exceptions.
         * @throws MslException if a user ID token is not bound to its master
         *         token.
         */
        initializeMessageBuilder: function initializeMessageBuilder(ctx, messageId, capabilities, entityAuthData, masterToken, userIdToken, serviceTokens, peerMasterToken, peerUserIdToken, peerServiceTokens, keyExchangeData) {
            // Primary and peer token combinations will be verified when the
            // message header is constructed. So delay those checks in favor of
            // avoiding duplicate code.
            if (!ctx.isPeerToPeer() && (peerMasterToken || peerUserIdToken))
                throw new MslInternalException("Cannot set peer master token or peer user ID token when not in peer-to-peer mode.");

            // If key exchange data is provided and we are not in peer-to-peer mode
            // then its master token should be used for querying service tokens.
            var serviceMasterToken;
            if (keyExchangeData && !ctx.isPeerToPeer()) {
                serviceMasterToken = keyExchangeData.keyResponseData.masterToken;
            } else {
                serviceMasterToken = masterToken;
            }

            // Set the initial service tokens based on the MSL store and provided
            // service tokens.
            var _serviceTokens = {};
            var tokens = ctx.getMslStore().getServiceTokens(serviceMasterToken, userIdToken);
            tokens.forEach(function(token) {
                _serviceTokens[token.name] = token;
            }, this);
            if (serviceTokens) {
                serviceTokens.forEach(function(token) {
                    _serviceTokens[token.name] = token;
                }, this);
            }

            // Set the peer-to-peer data.
            var _peerMasterToken;
            var _peerUserIdToken;
            var _peerServiceTokens = {};
            if (ctx.isPeerToPeer()) {
                _peerMasterToken = peerMasterToken;
                _peerUserIdToken = peerUserIdToken;

                // If key exchange data is provided then its master token should
                // be used to query peer service tokens.
                var peerServiceMasterToken;
                if (keyExchangeData)
                    peerServiceMasterToken = keyExchangeData.keyResponseData.masterToken;
                else
                    peerServiceMasterToken = peerMasterToken;

                // Set the initial peer service tokens based on the MSL store and
                // provided peer service tokens.
                var peerTokens = ctx.getMslStore().getServiceTokens(peerServiceMasterToken, peerUserIdToken);
                peerTokens.forEach(function(peerToken) {
                    _peerServiceTokens[peerToken.name] = peerToken;
                }, this);
                if (peerServiceTokens) {
                    peerServiceTokens.forEach(function(peerToken) {
                        _peerServiceTokens[peerToken.name] = peerToken;
                    }, this);
                }
            }

            // Set the primary fields.
            var _ctx = ctx;
            var _messageId = messageId;
            var _capabilities = capabilities;
            var _entityAuthData = entityAuthData;
            var _masterToken = masterToken;
            var _userIdToken = userIdToken;
            var _keyExchangeData = keyExchangeData;

            // Set default field values.
            var _nonReplayable = false;
            var _renewable = false;
            var _handshake = false;
            var _userAuthData = null;
            var _keyRequestData = {};

            // The properties.
            var props = {
                // MSL context.
                /** @type {MslContext} */
                _ctx: { value: _ctx, writable: false, enumerable: false, configurable: false },

                // Private members.
                /** @type {EntityAuthenticationData} */
                _entityAuthData: { value: _entityAuthData, writable: false, enumerable: false, configurable: false },
                /** @type {MasterToken} */
                _masterToken: { value: _masterToken, writable: true, enumerable: false, configurable: false },
                /** @type {number} */
                _messageId: { value: _messageId, writable: false, enumerable: false, configurable: false },
                /** @type {MessageCapabilities} */
                _capabilities: { value: _capabilities, writable: false, enumerable: false, configurable: false },
                /** @type {KeyExchangeData} */
                _keyExchangeData: { value: _keyExchangeData, writable: false, enumerable: false, configurable: false },

                /** @type {boolean} */
                _nonReplayable: { value: _nonReplayable, writable: true, enumerable: false, configurable: false },
                /** @type {boolean} */
                _handshake: { value: _handshake, writable: true, enumerable: false, configurable: false },

                /** @type {boolean} */
                _renewable: { value: _renewable, writable: true, enumerable: false, configurable: false },
                /** @type {KeyRequestData} */
                _keyRequestData:{ value: _keyRequestData, writable: false, enumerable: false, configurable: false },
                /** @type {UserAuthenticationData} */
                _userAuthData: { value: _userAuthData, writable: true, enumerable: false, configurable: false },
                /** @type {UserIdToken} */
                _userIdToken: { value: _userIdToken, writable: true, enumerable: false, configurable: false },
                /** @type {Object.<name,ServiceToken>} */
                _serviceTokens: { value: _serviceTokens, writable: false, enumerable: false, configurable: false },

                /** @type {MasterToken} */
                _peerMasterToken: { value: _peerMasterToken, writable: true, enumerable: false, configurable: false },
                /** @type {UserIdToken} */
                _peerUserIdToken: { value: _peerUserIdToken, writable: true, enumerable: false, configurable: false },
                /** @type {Object.<name,ServiceToken>} */
                _peerServiceTokens: { value: _peerServiceTokens, writable: false, enumerable: false, configurable: false },
            };
            Object.defineProperties(this, props);
        },

        /**
         * @return {number} the message ID the builder will use.
         */
        getMessageId: function getMessageId() {
            return this._messageId;
        },

        /**
         * <p>Set the message ID.</p>
         *
         * <p>This method will override the message ID that was computed when the
         * message builder was created, and should not need to be called in most
         * cases.</p>
         *
         * @param {number} messageId the message ID.
         * @return {MessageBuilder} this.
         * @throws MslInternalException if the message ID is out of range.
         */
        setMessageId: function setMessageId(messageId) {
            if (messageId < 0 || messageId > MslConstants.MAX_LONG_VALUE)
                throw new MslInternalException("Message ID " + messageId + " is out of range.");
            this._messageId = messageId;
            return this;
        },

        /**
         * @return {MasterToken} the primary master token or null if the message will use entity
         *         authentication data.
         */
        getMasterToken: function getMasterToken() {
            return this._masterToken;
        },

        /**
         * @return {UserIdToken} the primary user ID token or null if the message will use user
         *         authentication data.
         */
        getUserIdToken: function getUserIdToken() {
            return this._userIdToken;
        },

        /**
         * @return {KeyExchangeData} the key exchange data or null if there is none.
         */
        getKeyExchangeData: function getKeyExchangeData() {
            return this._keyExchangeData;
        },

        /**
         * @return {boolean} true if the message builder will create a message capable of
         *        encrypting the header data.
         */
        willEncryptHeader: function willEncryptHeader() {
            return (this._masterToken || this._entityAuthData.scheme.encrypts);
        },

        /**
         * @return {boolean} true if the message builder will create a message capable of
         *        encrypting the payload data.
         */
        willEncryptPayloads: function willEncryptPayloads() {
            return (this._masterToken ||
                    (!this._ctx.isPeerToPeer() && this._keyExchangeData) ||
                    this._entityAuthData.scheme.encrypts);
        },

        /**
         * @return {boolean} true if the message builder will create a message capable of
         *         integrity protecting the header data.
         */
        willIntegrityProtectHeader: function willIntegrityProtectHeader() {
            return (this._masterToken || this._entityAuthData.scheme.protectsIntegrity);
        },

        /**
         * @return {boolean} true if the message builder will create a message capable of
         *         integrity protecting the payload data.
         */
        willIntegrityProtectPayloads: function willIntegrityProtectPayloads() {
            return (this._masterToken ||
                (!this._ctx.isPeerToPeer() && this._keyExchangeData) ||
                this._entityAuthData.scheme.protectsIntegrity);
        },

        /**
         * Construct the message header from the current message builder state.
         *
         * @param {{result: function(MessageHeader), error: function(Error)}}
         *        callback the callback that will receive the message header or
         *        any thrown exceptions.
         * @throws MslCryptoException if there is an error encrypting or signing
         *         the message.
         * @throws MslMasterTokenException if the header master token is not
         *         trusted and needs to be to accept this message header.
         * @throws MslEntityAuthException if there is an error with the entity
         *         authentication data.
         * @throws MslMessageException if the message is non-replayable but does
         *         not include a master token.
         * @throws MslException should not happen.
         */
        getHeader: function getHeader(callback) {
            var self = this;
            AsyncExecutor(callback, function() {
                var response = (this._keyExchangeData) ? this._keyExchangeData.keyResponseData : null;
                var tokens = [];
                for (var name in this._serviceTokens)
                    tokens.push(this._serviceTokens[name]);
                var keyRequests = [];
                for (var key in this._keyRequestData)
                    keyRequests.push(this._keyRequestData[key]);
                var nonReplayableId;
                if (this._nonReplayable) {
                    if (!this._masterToken)
                        throw new MslMessageException(MslError.NONREPLAYABLE_MESSAGE_REQUIRES_MASTERTOKEN);
                    nonReplayableId = this._ctx.getMslStore().getNonReplayableId(this._masterToken);
                } else {
                    nonReplayableId = null;
                }
                var headerData = new MessageHeader.HeaderData(this._messageId, nonReplayableId, this._renewable, this._handshake, this._capabilities, keyRequests, response, this._userAuthData, this._userIdToken, tokens);
                var peerTokens = [];
                for (var peerName in this._peerServiceTokens)
                    peerTokens.push(this._peerServiceTokens[peerName]);
                var peerData = new MessageHeader.HeaderPeerData(this._peerMasterToken, this._peerUserIdToken, peerTokens);
                this.createMessageHeader(this._ctx, this._entityAuthData, this._masterToken, headerData, peerData, callback);
            }, self);
        },

        /**
         * <p>Construct a new message header.</p>
         *
         * @param {MslContext} ctx MSL context.
         * @param {EntityAuthenticationData} entityAuthData the entity authentication data. May be null if a
         *        master token is provided.
         * @param {MaterToken} masterToken the master token. May be null if entity
         *        authentication data is provided.
         * @param {HeaderData} headerData message header data container.
         * @param {HeaderPeerData} peerData message header peer data container.
         * @param {{result: function(MessageHeader), error: function(Error)}}
         *        callback the callback functions that will receive the message
         *        header or any thrown exceptions.
         * @throws MslEncodingException if there is an error encoding the JSON
         *         data.
         * @throws MslCryptoException if there is an error encrypting or signing
         *         the message.
         * @throws MslMasterTokenException if the header master token is not
         *         trusted and needs to be to accept this message header.
         * @throws MslEntityAuthException if there is an error with the entity
         *         authentication data.
         * @throws MslMessageException if no entity authentication data or master
         *         token is provided.
         */
        createMessageHeader: function createMessageHeader(ctx, entityAuthData, masterToken, headerData, peerData, callback) {
            MessageHeader.create(ctx, entityAuthData, masterToken, headerData, peerData, callback);
        },

        /**
         * @return {boolean} true if the message will be marked non-replayable.
         */
        isNonReplayable: function isNonReplayable() {
            return this._nonReplayable;
        },

        /**
         * Make the message non-replayable. If true this will also set the
         * handshake flag to false.
         *
         * @param {boolean} nonReplayable true if the message should be non-replayable.
         * @return {MessageBuilder} this.
         * @see #setHandshake(boolean)
         */
        setNonReplayable: function setNonReplayable(nonReplayable) {
            this._nonReplayable = nonReplayable;
            if (this._nonReplayable)
                this._handshake = false;
            return this;
        },

        /**
         * @return {boolean} true if the message will be marked renewable.
         */
        isRenewable: function isRenewable() {
            return this._renewable;
        },

        /**
         * Set the message renewable flag. If false this will also set the
         * handshake flag to false.
         *
         * @param {boolean} renewable true if the message is renewable.
         * @return {MessageBuilder} this.
         */
        setRenewable: function setRenewable(renewable) {
            this._renewable = renewable;
            if (!this._renewable)
                this._handshake = false;
            return this;
        },

        /**
         * @return {boolean} true if the message will be marked as a handshake message.
         */
        isHandshake: function isHandshake() {
            return this._handshake;
        },

        /**
         * Set the message handshake flag. If true this will also set the non-
         * replayable flag to false and the renewable flag to true.
         *
         * @param {boolean} handshake true if the message is a handshake message.
         * @return {MessageBuilder} this.
         * @see #setNonReplayable(boolean)
         * @see #setRenewable(boolean)
         */
        setHandshake: function setHandshake(handshake) {
            this._handshake = handshake;
            if (this._handshake) {
                this._nonReplayable = false;
                this._renewable = true;
            }
            return this;
        },

        /**
         * <p>Set or change the master token and user ID token. This will overwrite
         * any existing tokens. If the user ID token is not null then any existing
         * user authentication data will be removed.</p>
         *
         * <p>Changing these tokens may result in invalidation of existing service
         * tokens. Those service tokens will be removed from the message being
         * built.</p>
         *
         * <p>This is a special method for the {@link MslControl} class that assumes
         * the builder does not have key response data in trusted network mode.</p>
         *
         * @param {MasterToken} masterToken the master token.
         * @param {UserIdToken} userIdToken the user ID token. May be null.
         */
        setAuthTokens: function setAuthTokens(masterToken, userIdToken) {
            // Make sure the assumptions hold. Otherwise a bad message could be
            // built.
            if (userIdToken && !userIdToken.isBoundTo(masterToken))
                throw new MslInternalException("User ID token must be bound to master token.");
            // In trusted network mode key exchange data should only exist if this
            // is a server response. In which case this method should not be
            // getting called.
            if (this._keyExchangeData && !this._ctx.isPeerToPeer())
                throw new MslInternalException("Attempt to set message builder master token when key exchange data exists as a trusted network server.");

            // Load the stored service tokens.
            var storedTokens;
            try {
                storedTokens = this._ctx.getMslStore().getServiceTokens(masterToken, userIdToken);
            } catch (e) {
                // This should never happen because we did not provide a user ID
                // token.
                if (e instanceof MslException)
                    throw new MslInternalException("Invalid master token and user ID token combination despite checking above.", e);
                throw e;
            }

            // Remove any service tokens that will no longer be bound.
            var tokens = [];
            for (var name in this._serviceTokens)
                tokens.push(this._serviceTokens[name]);
            tokens.forEach(function(token) {
                if (token.isUserIdTokenBound() && !token.isBoundTo(userIdToken) ||
                    token.isMasterTokenBound() && !token.isBoundTo(masterToken))
                {
                    delete this._serviceTokens[token.name];
                }
            }, this);

            // Add any service tokens based on the MSL store replacing ones already
            // set as they may be newer. The application will have a chance to
            // manage the service tokens before the message is constructed and
            // sent.
            storedTokens.forEach(function(token) {
                this._serviceTokens[token.name] = token;
            }, this);

            // Set the new authentication tokens.
            this._masterToken = masterToken;
            this._userIdToken = userIdToken;
        },

        /**
         * <p>Set the user authentication data of the message.</p>
         *
         * <p>This will overwrite any existing user authentication data.</p>
         *
         * @param {UserAuthenticationData} userAuthData user authentication data to set. May be null.
         * @return {MessageBuilder} this.
         */
        setUserAuthenticationData: function setUserAuthenticationData(userAuthData) {
            this._userAuthData = userAuthData;
            return this;
        },

        /**
         * <p>Set the remote user of the message. This will create a user ID
         * token in trusted network mode or peer user ID token in peer-to-peer mode.</p>
         *
         * <p>Adding a new user ID token will not impact the service tokens; it is
         * assumed that no service tokens exist that are bound to the newly created
         * user ID token.</p>
         *
         * <p>This is a special method for the {@link MslControl} class that assumes
         * the builder does not already have a user ID token for the remote user
         * and does have a master token that the new user ID token can be bound
         * against.</p>
         *
         * @param {MslUser} user remote user.
         * @param {{result: function(boolean), error: function(Error)}} callback
         *        the callback will receive true on completion or any thrown
         *        exceptions.
         * @throws MslCryptoException if there is an error encrypting or signing
         *         the token data.
         * @throws MslException if there is an error creating the user ID token.
         */
        setUser: function setUser(user, callback) {
            var self = this;
            AsyncExecutor(callback, function() {
                // Make sure the assumptions hold. Otherwise a bad message could be
                // built.
                if (!this._ctx.isPeerToPeer() && this._userIdToken != null ||
                        this._ctx.isPeerToPeer() && this._peerUserIdToken != null)
                {
                    throw new MslInternalException("User ID token or peer user ID token already exists for the remote user.");
                }

                // If key exchange data is provided then its master token should be
                // used for the new user ID token and for querying service tokens.
                var uitMasterToken;
                if (this._keyExchangeData) {
                    uitMasterToken = this._keyExchangeData.keyResponseData.masterToken;
                } else {
                    uitMasterToken = (!this._ctx.isPeerToPeer()) ? this._masterToken : this._peerMasterToken;
                }

                // Make sure we have a master token to create the user for.
                if (!uitMasterToken)
                    throw new MslInternalException("User ID token or peer user ID token cannot be created because no corresponding master token exists.");

                // Create the new user ID token.
                var factory = this._ctx.getTokenFactory();
                factory.createUserIdToken(this._ctx, user, uitMasterToken, {
                    result: function(userIdToken) {
                        AsyncExecutor(callback, function() {
                            // Set the new user ID token.
                            if (!this._ctx.isPeerToPeer()) {
                                this._userIdToken = userIdToken;
                                this._userAuthData = null;
                            } else {
                                this._peerUserIdToken = userIdToken;
                            }

                            // Success.
                            return true;
                        }, self);
                    },
                    error: callback.error,
                });
            }, self);
        },

        /**
         * Add key request data to the message.
         *
         * @param {KeyRequestData} keyRequestData key request data to add.
         * @return {MessageBuilder} this.
         */
        addKeyRequestData: function addKeyRequestData(keyRequestData) {
            this._keyRequestData[keyRequestData.uniqueKey()] = keyRequestData;
            return this;
        },

        /**
         * Remove key request data from the message.
         *
         * @param {KeyRequestData} keyRequestData key request data to remove.
         * @return {MessageBuilder} this.
         */
        removeKeyRequestData: function removeKeyRequestData(keyRequestData) {
            delete this._keyRequestData[keyRequestData.uniqueKey()];
            return this;
        },

        /**
         * <p>Add a service token to the message. This will overwrite any service
         * token with the same name.</p>
         *
         * <p>Adding a service token with empty data indicates the recipient should
         * delete the service token.</p>
         *
         * @param {ServiceToken} serviceToken service token to add.
         * @return {MessageBuilder} this.
         * @throws MslMessageException if the service token serial numbers do not
         *         match the primary master token or primary user ID token of the
         *         message being built.
         */
        addServiceToken: function addServiceToken(serviceToken) {
            // If key exchange data is provided and we are not in peer-to-peer mode
            // then its master token should be used for querying service tokens.
            var serviceMasterToken;
            if (this._keyExchangeData && !this._ctx.isPeerToPeer()) {
                serviceMasterToken = this._keyExchangeData.keyResponseData.masterToken;
            } else {
                serviceMasterToken = this._masterToken;
            }

            // Make sure the service token is properly bound.
            if (serviceToken.isMasterTokenBound() && !serviceToken.isBoundTo(serviceMasterToken))
                throw new MslMessageException(MslError.SERVICETOKEN_MASTERTOKEN_MISMATCH, "st " + serviceToken + "; mt " + serviceMasterToken).setMasterToken(serviceMasterToken);
            if (serviceToken.isUserIdTokenBound() && !serviceToken.isBoundTo(this._userIdToken))
                throw new MslMessageException(MslError.SERVICETOKEN_USERIDTOKEN_MISMATCH, "st " + serviceToken + "; uit " + this._userIdToken).setMasterToken(serviceMasterToken).setUserIdToken(this._userIdToken);

            // Add the service token.
            this._serviceTokens[serviceToken.name] = serviceToken;
            return this;
        },

        /**
         * <p>Add a service token to the message if a service token with the same
         * name does not already exist.</p>
         *
         * <p>Adding a service token with empty data indicates the recipient should
         * delete the service token.</p>
         *
         * @param {ServiceToken} serviceToken service token to add.
         * @return {MessageBuilder} this.
         * @throws MslMessageException if the service token serial numbers do not
         *         match the master token or user ID token of the message being
         *         built.
         */
        addServiceTokenIfAbsent: function addServiceTokenIfAbsent(serviceToken) {
            if (!this._serviceTokens[serviceToken.name])
                this.addServiceToken(serviceToken);
            return this;
        },

        /**
         * <p>Exclude a service token from the message.</p>
         *
         * <p>The service token will not be sent in the built message. This is not
         * the same as requesting the remote entity delete a service token.</p>
         *
         * @param {string} name service token name.
         * @return {MessageBuilder} this.
         */
        excludeServiceToken: function excludeServiceToken(name) {
            delete this._serviceTokens[name];
            return this;
        },

        /**
         * <p>Mark a service token for deletion, if it exists. Otherwise this
         * method does nothing.</p>
         *
         * <p>The service token will be sent in the built message with an empty
         * value. This is not the same as requesting that a service token be
         * excluded from the message.</p>
         *
         * @param {string} name service token name.
         * @param {{result: function(MessageBuilder), error: function(Error)}}
         *        callback the callback that will receive this message builder
         *        upon completion or any thrown exceptions.
         */
        deleteServiceToken: function deleteServiceToken(name, callback) {
            var self = this;
            AsyncExecutor(callback, function() {
                // Do nothing if the original token does not exist.
                var originalToken = this._serviceTokens[name];
                if (!originalToken)
                    return this;

                // Rebuild the original token with empty service data.
                var masterToken = originalToken.isMasterTokenBound() ? this._masterToken : null;
                var userIdToken = originalToken.isUserIdTokenBound() ? this._userIdToken : null;
                ServiceToken.create(this._ctx, name, EMPTY_DATA, masterToken, userIdToken, false, null, new NullCryptoContext(), {
                    result: function(token) {
                        AsyncExecutor(callback, function() {
                            return this.addServiceToken(token);
                        }, self);
                    },
                    error: function(e) {
                        if (e instanceof MslException)
                            e = new MslInternalException("Failed to create and add empty service token to message.", e);
                        callback.error(e);
                    }
                });
            }, self);
        },

        /**
         * @return {Array.<ServiceToken>} the unmodifiable set of service tokens that will be included in
         *         the built message.
         */
        getServiceTokens: function getServiceTokens() {
            var tokens = [];
            for (var name in this._serviceTokens)
                tokens.push(this._serviceTokens[name]);
            return tokens;
        },

        /**
         * @return {MasterToken} the peer master token or null if there is none.
         */
        getPeerMasterToken: function getPeerMasterToken() {
            return this._peerMasterToken;
        },

        /**
         * @return {UserIdToken} the peer user ID token or null if there is none.
         */
        getPeerUserIdToken: function getPeerUserIdToken() {
            return this._peerUserIdToken;
        },

        /**
         * <p>Set the peer master token and peer user ID token of the message. This
         * will overwrite any existing peer master token or peer user ID token.</p>
         *
         * <p>Changing these tokens may result in invalidation of existing peer
         * service tokens. Those peer service tokens will be removed from the
         * message being built.</p>
         *
         * @param {MasterToken} masterToken peer master token to set. May be null.
         * @param {UserIdToken} userIdToken peer user ID token to set. May be null.
         * @return {MessageBuilder} this.
         * @throws MslMessageException if the peer user ID token is not bound to
         *         the peer master token.
         */
        setPeerAuthTokens: function setPeerAuthTokens(masterToken, userIdToken) {
            if (!this._ctx.isPeerToPeer())
                throw new MslInternalException("Cannot set peer master token or peer user ID token when not in peer-to-peer mode.");
            if (userIdToken && !masterToken)
                throw new MslInternalException("Peer master token cannot be null when setting peer user ID token.");
            if (userIdToken && !userIdToken.isBoundTo(masterToken))
                throw new MslMessageException(MslError.USERIDTOKEN_MASTERTOKEN_MISMATCH, "uit " + userIdToken + "; mt " + masterToken).setMasterToken(masterToken).setUserIdToken(userIdToken);

            // Load the stored peer service tokens.
            var storedTokens;
            try {
                storedTokens = this._ctx.getMslStore().getServiceTokens(masterToken, userIdToken);
            } catch (e) {
                // The checks above should have prevented any invalid master token,
                // user ID token combinations.
                if (e instanceof MslException)
                    throw new MslInternalException("Invalid peer master token and user ID token combination despite proper check.", e);
                throw e;
            }

            // Remove any peer service tokens that will no longer be bound.
            var names = Object.keys(this._peerServiceTokens);
            names.forEach(function(name) {
                var token = this._peerServiceTokens[name];
                if (token.isUserIdTokenBound() && !token.isBoundTo(userIdToken)) {
                    delete this._peerServiceTokens[name];
                    return;
                }
                if (token.isMasterTokenBound() && !token.isBoundTo(masterToken)) {
                    delete this._peerServiceTokens[name];
                    return;
                }
            }, this);

            // Add any peer service tokens based on the MSL store if they are not
            // already set (as a set one may be newer than the stored one).
            storedTokens.forEach(function(token) {
                var name = token.name;
                if (!this._peerServiceTokens[name])
                    this._peerServiceTokens[name] = token;
            }, this);

            // Set the new peer authentication tokens.
            this._peerUserIdToken = userIdToken;
            this._peerMasterToken = masterToken;
            return this;
        },

        /**
         * <p>Add a peer service token to the message. This will overwrite any peer
         * service token with the same name.</p>
         *
         * <p>Adding a service token with empty data indicates the recipient should
         * delete the service token.</p>
         *
         * @param {ServiceToken} serviceToken service token to add.
         * @return {MessageBuilder} this.
         * @throws MslMessageException if the service token serial numbers do not
         *         match the peer master token or peer user ID token of the message
         *         being built.
         */
        addPeerServiceToken: function addPeerServiceToken(serviceToken) {
            if (!this._ctx.isPeerToPeer())
                throw new MslInternalException("Cannot set peer service tokens when not in peer-to-peer mode.");
            if (serviceToken.isMasterTokenBound() && !serviceToken.isBoundTo(this._peerMasterToken))
                throw new MslMessageException(MslError.SERVICETOKEN_MASTERTOKEN_MISMATCH, "st " + serviceToken + "; mt " + this._peerMasterToken).setMasterToken(this._peerMasterToken);
            if (serviceToken.isUserIdTokenBound() && !serviceToken.isBoundTo(this._peerUserIdToken))
                throw new MslMessageException(MslError.SERVICETOKEN_USERIDTOKEN_MISMATCH, "st " + serviceToken + "; uit " + this._peerUserIdToken).setMasterToken(this._peerMasterToken).setUserIdToken(this._peerUserIdToken);

            // Add the peer service token.
            this._peerServiceTokens[serviceToken.name] = serviceToken;
            return this;
        },

        /**
         * <p>Add a peer service token to the message if a peer service token with
         * the same name does not already exist.</p>
         *
         * <p>Adding a service token with empty data indicates the recipient should
         * delete the service token.</p>
         *
         * @param {ServiceToken} serviceToken service token to add.
         * @return {MessageBuilder} this.
         * @throws MslMessageException if the service token serial numbers do not
         *         match the peer master token or peer user ID token of the message
         *         being built.
         */
        addPeerServiceTokenIfAbsent: function addPeerServiceTokenIfAbsent(serviceToken) {
            if (!this._peerServiceTokens[serviceToken.name])
                this.addPeerServiceToken(serviceToken);
            return this;
        },

        /**
         * <p>Exclude a peer service token from the message.</p>
         *
         * <p>The service token will not be sent in the built message. This is not
         * the same as requesting the remote entity delete a service token.</p>
         *
         * @param {string} name service token name.
         * @return {MessageBuilder} this.
         */
        excludePeerServiceToken: function excludePeerServiceToken(name) {
            delete this._peerServiceTokens[name];
            return this;
        },

        /**
         * <p>Mark a peer service token for deletion, if it exists. Otherwise this
         * method does nothing.</p>
         *
         * <p>The service token will be sent in the built message with an empty
         * value. This is not the same as requesting that a service token be
         * excluded from the message.</p>
         *
         * @param {string} name service token name.
         * @param {{result: function(MessageBuilder), error: function(Error)}}
         *        callback the callback that will receive this message builder
         *        upon completion or any thrown exceptions.
         */
        deletePeerServiceToken: function deletePeerServiceToken(name, callback) {
            var self = this;
            AsyncExecutor(callback, function() {
                // Do nothing if the original token does not exist.
                var originalToken = this._peerServiceTokens[name];
                if (!originalToken)
                    return this;

                // Rebuild the original token with empty service data.
                var peerMasterToken = originalToken.isMasterTokenBound() ? this._peerMasterToken : null;
                var peerUserIdToken = originalToken.isUserIdTokenBound() ? this._peerUserIdToken : null;
                ServiceToken.create(this._ctx, name, EMPTY_DATA, peerMasterToken, peerUserIdToken, false, null, new NullCryptoContext(), {
                    result: function(token) {
                        AsyncExecutor(callback, function() {
                            return this.addPeerServiceToken(token);
                        }, self);
                    },
                    error: function(e) {
                        if (e instanceof MslException)
                            e = new MslInternalException("Failed to create and add empty peer service token to message.", e);
                        callback.error(e);
                    }
                });
            }, self);
        },

        /**
         * @return {Array.<ServiceToken>} the unmodifiable set of peer service tokens that will be included in
         *         the built message.
         */
        getPeerServiceTokens: function getPeerServiceTokens() {
            var tokens = [];
            for (var name in this._peerServiceTokens)
                tokens.push(this._peerServiceTokens[name]);
            return tokens;
        },
    });

    /**
     * <p>Create a new message builder that will craft a new message. If a
     * message ID is provided it will be used for the new message's message ID.
     * Otherwise a random message ID will be generated.</p>
     *
     * @param {MslContext} ctx MSL context.
     * @param {MasterToken} masterToken master token. May be null unless a user ID token is
     *        provided.
     * @param {UserIdToken} userIdToken user ID token. May be null.
     * @param {?number} messageId the message ID to use. Must be within range.
     * @param {{result: function(MessageBuilder), error: function(Error)}}
     *        callback the callback that will receive the message builder or
     *        any thrown exceptions.
     * @throws MslException if a user ID token is not bound to its
     *         corresponding master token.
     */
    var MessageBuilder$create = function MessageBuilder$create(ctx, masterToken, userIdToken, messageId, callback) {
        new MessageBuilder(ctx, masterToken, userIdToken, messageId, callback);
    };

    // Exports.
    module.exports.create = MessageBuilder$create;
    module.exports.incrementMessageId = MessageBuilder$incrementMessageId;
    module.exports.decrementMessageId = MessageBuilder$decrementMessageId;
})(require, (typeof module !== 'undefined') ? module : mkmodule('MessageBuilder'));
