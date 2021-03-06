// @flow
/**
 * Configure a given context to support Apollo
 *
 * If Apollo network settings are provided during render then we need to expose
 * some important objects to the vm context. ApolloNetwork should have two
 * properties: 'url' (for the URL of the GraphQL endpoint) and 'headers'
 * for a key-value map of headers to send to the GraphQL endpoint. This
 * can include things such as cookies and xsrf tokens.
 * Requests will automatically timeout after 1000ms, unless another
 * timeout is provided via a 'timeout' property.
 */
import * as ApolloClientModule from "apollo-client";
import {InMemoryCache} from "apollo-cache-inmemory";
import {createHttpLink} from "apollo-link-http";
import fetch from "node-fetch";

import type {NormalizedCacheObject} from "apollo-cache-inmemory";
import type {ApolloClient, ApolloCache, ApolloLink} from "apollo-client";

export type ApolloNetworkConfiguration = {
    timeout?: number,
    url?: string,
    headers?: any,
};

export type ApolloGlobals = {
    +ApolloClientModule: typeof ApolloClientModule,
    +ApolloNetworkLink: ApolloLink,
    +ApolloCache: ApolloCache<NormalizedCacheObject>,
};

export type ApolloClientInstance = ApolloClient<NormalizedCacheObject>;

const BAD_URL = "BAD_URL";

const timeout = async (timeout: number, errorMsg: string): Promise<void> => {
    return new Promise((resolve, reject) => {
        setTimeout(() => {
            reject(new Error(errorMsg));
        }, timeout);
    });
};

export default function configureApolloNetwork(
    apolloNetwork: ?ApolloNetworkConfiguration,
): ?ApolloGlobals {
    if (apolloNetwork == null) {
        return null;
    }

    const handleNetworkFetch = async (url: string, params: any) => {
        if (!url || url === BAD_URL) {
            throw new Error(
                `ApolloNetwork must have a valid url (URL: ${url})`,
            );
        }

        const result = await Promise.race([
            fetch(url, params),
            // After a specified timeout we abort the request if
            // it's still on-going.
            timeout(
                apolloNetwork.timeout || 1000,
                `Server response exceeded timeout (URL: ${url})`,
            ),
        ]);

        // Handle server errors
        if (!result || result.status !== 200) {
            throw new Error(`Server returned an error (URL: ${url})`);
        }

        return result;
    };

    const apolloLink = createHttpLink({
        // HACK(briang): If you give the uri undefined, it will call
        // fetch("/graphql") but we want to ensure that an undefined URL
        // will fail the request.
        uri: apolloNetwork.url || BAD_URL,
        fetch: handleNetworkFetch,
        headers: apolloNetwork.headers,
    });

    /**
     * Build all the configuration into an object.
     */
    const apolloGlobals: ApolloGlobals = {
        // We need to use the server-side Node.js version of
        // apollo-client module import rather than the "browser" version.
        // So we provide the Node-imported version to our render context that
        // would otherwise be importing code inside of the JSDOM browser-like
        // code.
        ApolloClientModule: ApolloClientModule,

        // Additionally, we need to build a request mechanism for actually
        // making a network request to our GraphQL endpoint. We use the
        // node-fetch module for making this request. This logic
        // should be very similar to the logic held in apollo-wrapper.jsx.
        // NOTE(somewhatabstract): We have to cast to any here since the type
        // of ApolloLink exported from apollo-link-http and the one exported
        // from apollo-client aren't seen as the same type by flow (annoying).
        ApolloNetworkLink: (apolloLink: any),

        ApolloCache: new InMemoryCache(),
    };

    return apolloGlobals;
}
