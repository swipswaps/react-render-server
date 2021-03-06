// @flow
/**
 * The high-level logic for our serving endpoints (api routes).
 */
import {URL} from "url";
import bodyParser from "body-parser";
import express from "express";

import {extractErrorInfo, getLogger} from "./logging.js";
import profile from "./profile.js";

import fetchPackage, {flushCache, flushUnusedCache} from "./fetch_package.js";
import * as renderSecret from "./secret.js";
import render from "./render.js";

import type {$Request, $Response, NextFunction} from "express";
import type {Logger, RenderBody, RequestStats} from "./types.js";

// We keep track of how many render requests are currently "in
// flight", to help us estimate how long a new request will take.
let pendingRenderRequests = 0;

const app = express();
app.use(bodyParser.json({limit: "5mb"}));

/**
 * Server-side render a react component.
 *
 * The contents to render are sent in the request body as json, in
 * the following format:
 * {
 *    "urls": [
 *        "http://kastatic.org/genfiles/javascript/en/corelibs-package-xx.js",
 *        "http://kastatic.org/genfiles/javascript/en/shared-package-xx.js",
 *        "http://kastatic.org/genfiles/javascript/en/content-library-xx.js"
 *    ],
 *    "globals": {
 *        "location": "http://khanacademy.org/science/physics",
 *        "KA": {
 *            "language": "en"
 *        }
 *    },
 *    "props": {
 *        "href": "http://www.google.com",
 *        "children": "Google"
 *    },
 *    "secret": "...."
 * }
 *
 * 'urls' should be specified in topological-sort order; they are
 * executed in the order listed here. The last one should always be the
 * instigator of the render.
 *
 * `globals` is a map of global variables to their values. These values will be
 * set in the JavaScript VM context before the entry point specified by
 * `entry` is `require()`'d.
 *
 * 'props' are passed as the props to the react component being rendered.
 *
 * 'secret' is a shared secret.  It must equal the value of the 'secret'
 * file in the server's base-directory, or the server will deny the request.
 * NOTE: In dev mode, the secret field is ignored.
 *
 * The return format is also json:
 * {
 *     "html": "<a href='http://www.google.com' class='link141'>Google</a>",
 *     "css": {
 *         content: ".link141{backgroundColor:transparent;}",
 *         renderedClassNames: ["link141"]
 *     }
 * }
 *
 * css will only be returned if the component makes use of Aphrodite
 * (https://github.com/Khan/aphrodite).
 */

// This middleware manages the number of connections, and logs about it.
app.use(
    "/render",
    (req: $Request, res: $Response, next: NextFunction): mixed => {
        // The number of concurrent requests will fluctuate as this
        // request is evaluated.  We arbitrarily take the number at
        // our-request-start as the value we log.
        // We store the stats-to-log in `req` as a hacky way of holding
        // per-request stats.
        res.locals.requestStats = ({
            pendingRenderRequests: pendingRenderRequests,
            packageFetches: 0,
            fromCache: 0,
            vmContextSize: 0,
            createdVmContext: false,
        }: RequestStats);

        const logging = getLogger(req);

        pendingRenderRequests++;
        const renderProfile = profile.start(
            logging,
            `/render (active requests: ${pendingRenderRequests})`,
        );

        // Register for the response finish so we can finish up our stats.
        res.on("finish", () => {
            pendingRenderRequests--;
            if (res.statusCode < 300) {
                // only log on successful fetches
                const renderBody: RenderBody = (req.body: any);
                renderProfile.end(
                    `render-stats for ${
                        renderBody.urls[renderBody.urls.length - 1]
                    }: ${JSON.stringify(res.locals.requestStats) || ""}`,
                );
            }
        });
        next();
    },
);

const checkSecret = function(
    req: $Request,
    res: $Response,
    next: NextFunction,
): mixed {
    const logging = getLogger(req);
    const {secret}: RenderBody = (req.body: any);
    renderSecret.matches(
        logging,
        secret,
        (err: ?Error, secretMatches: ?boolean) => {
            if (err != null || !secretMatches) {
                res.status(400).send({error: "Missing or invalid secret"});
                return;
            }
            next();
        },
    );
};

const logAndGetError = function(
    logging: Logger,
    context: string,
    err: any,
    globals: any,
): mixed {
    const errorString = extractErrorInfo(err);

    /**
     * Let's log some info here.
     *
     * context:
     *      Some context on the workflow or stage in which the error
     *      occurred.
     *
     * globals.location:
     *      What URL was being rendered
     *
     * errorString:
     *      The given error as a string.
     */
    logging.error(`${context} (${globals["location"]}): ${errorString}`);

    // Error handler for fetching failures.
    if (err.error && (!err.response || !err.response.error)) {
        // set for timeouts, in particular
        err = err.error;
    }

    return {
        error: `${err}`,
        stack: err.stack,
    };
};

const respond400BadRequest = (
    logging: Logger,
    res: $Response,
    error,
    value,
) => {
    logging.error(error);
    return res.status(400).json({error, value});
};

const isValidAbsoluteURL = (str: string): boolean => {
    try {
        // eslint-disable-next-line no-new
        new URL(str);
        return true;
    } catch (e) {
        return false;
    }
};
app.post("/render", checkSecret, async (req: $Request, res: $Response) => {
    // Validate the input.
    const {urls, props, globals}: RenderBody = (req.body: any);
    const logging = getLogger(req);

    if (!Array.isArray(urls) || !urls.every(isValidAbsoluteURL)) {
        return respond400BadRequest(
            logging,
            res,
            'Missing "urls" keyword in POST JSON input, ' +
                'or one or more "urls" are not valid',
            urls,
        );
    } else if (typeof props !== "object" || Array.isArray(props)) {
        return respond400BadRequest(
            logging,
            res,
            'Missing "props" keyword in POST JSON input, ' +
                'or "props" is not an object, or it has non-string keys.',
            props,
        );
    } else if (
        globals &&
        globals["location"] &&
        !isValidAbsoluteURL(globals["location"])
    ) {
        return respond400BadRequest(
            logging,
            res,
            'globals["location"] is not a valid URL',
            props,
        );
    }

    // We filter out all non-JS URLs as we don't need to download them in
    // order to render the page (for example .css files may be specified and
    // we want to ignore them)
    const jsUrls = urls.filter(
        (url) => url.startsWith("http") && url.endsWith(".js"),
    );

    if (jsUrls.length === 0) {
        return respond400BadRequest(
            logging,
            res,
            'Error in "urls" keyword in POST JSON input, ' +
                "no valid JS urls were specified.",
            urls,
        );
    }

    // Fetch the entry point and its dependencies.
    const requestStats: RequestStats = (res.locals.requestStats: any);
    const fetchPackages = async () => {
        /**
         * Remove any unused files from the fetch_package cache. We do this
         * before we start any requests to make sure we don't overfill the
         * cache with all the new data we download.
         */
        flushUnusedCache();

        try {
            const fetchPromises = jsUrls.map((url) =>
                fetchPackage(logging, url, "SERVER", requestStats),
            );
            return await Promise.all(fetchPromises);
        } catch (err) {
            const errorResponse = logAndGetError(
                logging,
                "FETCH FAIL",
                err,
                globals,
            );
            res.status(500).json(errorResponse);
            return null;
        }
    };

    const packages = await fetchPackages();
    if (packages == null) {
        return;
    }

    try {
        const renderedState = await render(
            logging,
            packages,
            props,
            globals,
            requestStats,
        );

        // We store the updated request-stats in renderedState
        // (the only way to get the updated data back from our
        // subprocess); pop that out into update req.requestStats.
        res.locals.requestStats = renderedState.requestStats;
        delete renderedState.requestStats;
        res.json(renderedState);
    } catch (err) {
        const errorResponse = logAndGetError(
            logging,
            "RENDER FAIL",
            err,
            globals,
        );
        /**
         * Even in the case of a bad render, we want to categorize this as
         * a server error.
         */
        res.status(500).json(errorResponse);
    }
});

/**
 * Flush the cache.
 *
 * This can be useful when there are weird errors that may be due to bad
 * caching, or for testing.
 *
 * The post data is sent in the request body as json, in the following format:
 * {
 *    "secret": "...."
 * }
 *
 * 'secret' is a shared secret.  It must equal the value of the 'secret'
 * file in the server's base-directory, or the server will deny the request.
 * NOTE: In dev mode, the secret field is ignored.
 *
 * We respond with the instance that was flushed.
 * TODO(WEB-1410): how do we flush *all* the instances??
 *                 Datastore! See graphql-gateway
 */
app.post("/flush", checkSecret, (req: $Request, res: $Response) => {
    flushCache();
    res.send((process.env["GAE_INSTANCE"] || "dev") + "\n");
});

app.get("/_api/ping", (req: $Request, res: $Response) => res.send("pong!\n"));

app.get("/_api/version", (req: $Request, res: $Response) => {
    // This will return the module version ID we set when deploying.
    res.send((process.env["GAE_VERSION"] || "dev") + "\n");
});
// These are used by the Managed VM lifecycle functions:
// https://cloud.google.com/appengine/docs/managed-vms/custom-runtimes#lifecycle_events
app.get("/_ah/health", (req: $Request, res: $Response) => res.send("ok!\n"));
app.get("/_ah/start", (req: $Request, res: $Response) => res.send("ok!\n"));
app.get("/_ah/stop", (req: $Request, res: $Response) => res.send("ok!\n"));

// Simplistic priming endpoint. Calling this endpoint uses CPU and thus
// hopefully causes the autoscaler to spin up more instances. This endpoint
// takes about 2 seconds when called locally on my laptop.
// TODO(somewhatabstract): Is this useful? Does it work?
app.get("/prime", (req: $Request, res: $Response) => {
    for (let i = 0; i < 3000000000; i++) {
        // noop
    }
    res.send("ok\n");
});

export default app;
