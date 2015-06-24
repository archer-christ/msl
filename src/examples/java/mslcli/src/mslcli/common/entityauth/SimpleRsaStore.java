/**
 * Copyright (c) 2014 Netflix, Inc.  All rights reserved.
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
package mslcli.common.entityauth;

import java.security.KeyPair;
import java.security.PrivateKey;
import java.security.PublicKey;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import com.netflix.msl.entityauth.RsaStore;

/**
 * <p>An example RSA key store.</p>
 * 
 * @author Vadim Spector <vspector@netflix.com>
 */
public class SimpleRsaStore implements RsaStore {
    /**
     * <p>Create a new RSA store that will return the provided public and/or
     * private keys for the specified server RSA key pair ID.
     *
     * Multiple server instances may be configured to use the same RSA key pair id.
     *
     * A public key must be provided to authenticate remote entities. A private key
     * must be provided to authenticate local entities.</p>
     * 
     * @param keys RSA key pairs keyed by server entity id
     */
    public SimpleRsaStore(final Map<String,KeyPair> keys) {
        this.keys = keys;
    }
    
    @Override
    public Set<String> getIdentities() {
        return keys.keySet();
    }

    @Override
    public PublicKey getPublicKey(final String identity) {
        final KeyPair pair = keys.get(identity);
        return (pair != null) ? pair.getPublic() : null;
    }

    @Override
    public PrivateKey getPrivateKey(final String identity) {
        final KeyPair pair = keys.get(identity);
        return (pair != null) ? pair.getPrivate() : null;
    }

    private final Map<String,KeyPair> keys;
}
