// @flow

/**
 * Create a render context object.
 */

import vm from "vm";

import {JSDOM, VirtualConsole} from "jsdom";

import profile from "./profile.js";
import {CustomResourceLoader} from "./custom-resource-loader.js";

import type {
    Globals,
    JavaScriptPackage,
    RenderContext,
    RequestStats,
    Logger,
} from "./types.js";

type RenderContextWithSize = {
    context: RenderContext,
    cumulativePackageSize: number,
};

const getScript = function(
    fnOrText: Function | string,
    options: vm$ScriptOptions,
): any {
    switch (typeof fnOrText) {
        case "function":
            const script = "(\n" + fnOrText.toString() + "\n)()";
            const _options = Object.assign({}, options);
            _options.lineOffset = -1;
            return new vm.Script(script, _options);

        case "string":
            return new vm.Script(fnOrText, options);

        default:
            throw new Error("Must be a function or string");
    }
};

const runInContext = function(
    jsdomContext: RenderContext,
    fnOrText: Function | string,
    options: vm$ScriptOptions = {},
): any {
    return jsdomContext.runVMScript(getScript(fnOrText, options));
};

const patchTimers = (): void => {
    let warned = false;
    const patchCallbackFnWithGate = (
        obj: any,
        fnName: string,
        gateName: string,
    ) => {
        const old = obj[fnName];
        delete obj[fnName];
        obj[fnName] = (callback, ...args) => {
            const gatedCallback = () => {
                if (obj[gateName]) {
                    callback();
                    return;
                }
                if (!warned) {
                    warned = true;
                    /**
                     * This has to use console because it runs in the VM
                     * and so it doesn't have access to our winston logging.
                     */
                    // eslint-disable-next-line no-console
                    console.warn("Dangling timer(s) encountered");
                }
            };
            return old(gatedCallback, ...args);
        };
    };

    // Patch the timer functions on window so that dangling timers don't kill
    // us when we close the window.
    patchCallbackFnWithGate(window, "setTimeout", "__SSR_ACTIVE__");
    patchCallbackFnWithGate(window, "setInterval", "__SSR_ACTIVE__");
    patchCallbackFnWithGate(window, "requestAnimationFrame", "__SSR_ACTIVE__");
};

const createVirtualConsole = () => {
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (e: Error) => {
        if (e.message.indexOf("Could not load img") >= 0) {
            // We know that images cannot load. We're deliberately blocking
            // them.
            return;
        }
        // eslint-disable-next-line no-console
        console.error(`JSDOM: ${e.stack}`);
    });
    virtualConsole.sendTo(console, {omitJSDOMErrors: true});
    return virtualConsole;
};

/**
 * Create the VM context in which to render.
 *
 * @param {string} locationUrl
 * @param {any} globals
 * @param {[{content: string, url: string}]} jsPackages
 * @returns {{context: JSDOM, cumulativePackageSize: number}}
 */
const createRenderContext = function(
    logging: Logger,
    locationUrl: string,
    globals: Globals,
    jsPackages: Array<JavaScriptPackage>,
    requestStats?: RequestStats,
): RenderContextWithSize {
    const resourceLoader = new CustomResourceLoader(logging, requestStats);

    // A minimal document, for parts of our code that assume there's a DOM.
    const context: RenderContext = (new JSDOM(
        "<!DOCTYPE html><html><head></head><body></body></html>",
        {
            // The base location. We can't modify window.location directly
            // but this allows us to provide one.
            url: locationUrl,
            // We want to run scripts that would normally run in a web browser
            // so we give them as much leeway as we can. Obviously, this is a
            // security risk if access to this service is not properly secured.
            // Make sure to use a secret!
            runScripts: "dangerously",
            // We use a custom loader for our scripts and other resource
            // requests so that we can output them to the log. Helps us debug
            // that what we think is happening is happening.
            resources: resourceLoader,
            // There are certain things that a browser provides because it is
            // actually rendering things. While JSDOM does not render, we can
            // have it pretend that it is (it still isn't).
            pretendToBeVisual: true,
            // We pass in our own console, which we can use to filter out
            // messages we really really don't care about.
            virtualConsole: createVirtualConsole(),
        },
    ): any);

    // This means we can run scripts inside the jsdom context.
    context.run = (fnOrText, options) =>
        runInContext(context, fnOrText, options);

    // Let's make sure our sandbox window is how we want.
    const sandbox = context.window;
    sandbox.global = sandbox;
    sandbox.self = sandbox;

    /**
     * This makes sure that qTip2 doesn't try to use the canvas.
     *
     * TODO(somewhatabstact): Do we need this hack still? Is there are better
     * way? $FlowFixMe
     */
    sandbox.HTMLCanvasElement.prototype.getContext = undefined;

    // Setup callback.
    // This indicates to the rendering code that it is involved in SSR
    // and provides it the means to register for SSR to occur.
    // This has to happen before we import the entry point, so it can
    // invoke this method.
    //
    // The callback provided by the rendering code must return a promise that
    // will perform the render, including data fetch calls using
    // getDataFromTree or whatever call is appropriate.
    //
    // The getRenderPromiseCallback takes the props and an ApolloClient
    // instance (or null, if Apollo is not needed), and returns a promise of
    // the rendered content.
    //
    // An entrypoint example for invoking __registerForSSR__:
    //
    //     const renderElement = (props, maybeApolloClient) =>
    //         Promise.resolve({html, css});
    //     window.__registerForSSR__(renderElement);
    //
    context.run(() => {
        window.__registerForSSR__ = (getRenderPromiseCallback) => {
            window.__rrs = {
                getRenderPromiseCallback,
            };
        };
        window.__SSR_ACTIVE__ = true;
    });
    context.run(patchTimers);

    // Set up a close handler to be called after rendering is done.
    context.close = () => {
        context.run(() => {
            window.__SSR_ACTIVE__ = false;
        });
        resourceLoader.close();
        context.window.close();
    };

    // Now, before we load any code, we make sure any globals we've been asked
    // to set are made available to the VM context.
    if (globals) {
        Object.keys(globals).forEach((key) => {
            // Location is a special case, so we want to block changing that.
            if (key !== "location") {
                context.window[key] = globals[key];
            }
        });
    }

    // Now we execute inside the sandbox context each script package.
    let cumulativePackageSize = 0;
    jsPackages.forEach(({content, url}) => {
        context.run(content, {filename: url});

        // A size estimate; it's really just an estimate
        // though as we don't consider anything but the script text.
        // Since we're running in node, we assume 2 bytes
        // per character in the text. We aren't accounting for
        // other info associated with that, though.
        // This is used in our request stats when determining how "big"
        // the code was to perform the current render.
        cumulativePackageSize += content.length * 2;
    });

    return {
        context,
        cumulativePackageSize,
    };
};

/**
 *
 * @param {string} locationUrl
 * @param {any} globals
 * @param {[{content: string, url: string}]} jsPackages
 * @param {any} requestStats
 * @returns {JSDOM}
 */
export default function createRenderContextWithStats(
    logging: Logger,
    locationUrl: string,
    globals: Globals,
    jsPackages: Array<any>,
    requestStats?: RequestStats,
): RenderContext {
    const vmConstructionProfile = profile.start(
        logging,
        `building VM ${(globals && `for ${globals["location"]}`) || ""}`,
    );

    const {context, cumulativePackageSize} = createRenderContext(
        logging,
        locationUrl,
        globals,
        jsPackages,
        requestStats,
    );

    vmConstructionProfile.end();

    if (requestStats) {
        requestStats.createdVmContext = true;
        requestStats.vmContextSize = cumulativePackageSize;
    }

    return context;
}
