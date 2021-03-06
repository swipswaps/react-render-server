// @flow
import fs from "fs";
import {promisify} from "util";

import {assert} from "chai";
import sinon from "sinon";
import args from "./arguments.js";
import * as renderSecret from "./secret.js";
import {rootLogger} from "./logging.js";

import type {Logger} from "./types.js";

const matches: (Logger, string) => Promise<boolean> = promisify(
    renderSecret.matches,
);

describe("secret", () => {
    afterEach(() => {
        sinon.restore();
    });

    it("can handle missing secret file", async () => {
        // Arrange
        sinon
            .stub(fs, "readFile")
            .callsFake(
                (
                    filePath: string,
                    encoding: null,
                    callback: (?Error, ?string) => void,
                ) => callback(new Error("File not found")),
            );
        sinon.stub(args, "dev").get(() => false);

        // Act
        const promise = matches(rootLogger, "sekret");

        // Assert
        await assert.isRejected(promise, "File not found");
    });

    it("can handle empty secret file", async () => {
        // Arrange
        sinon
            .stub(fs, "readFile")
            .callsFake(
                (
                    filePath: string,
                    encoding: null,
                    callback: (?Error, ?string) => void,
                ) => callback(null, ""),
            );
        sinon.stub(args, "dev").get(() => false);

        // Act
        const promise = matches(rootLogger, "sekret");

        // Assert
        await assert.isRejected(promise, "secret file is empty!");
    });

    it("can match secret to actual value", async () => {
        // Arrange
        sinon
            .stub(fs, "readFile")
            .callsFake(
                (
                    filePath: string,
                    encoding: null,
                    callback: (?Error, ?string) => void,
                ) => callback(null, "sekret"),
            );
        sinon.stub(args, "dev").get(() => false);

        // Act
        const valueMatches = await matches(rootLogger, "sekret");

        // Assert
        assert.isTrue(valueMatches, "Should match secret value ");
    });

    it("can match cached secret to actual value", async () => {
        // Arrange
        sinon.stub(args, "dev").get(() => false);

        // On the second run through, the fs.readFile function should not be called.
        sinon
            .stub(fs, "readFile")
            .callsFake(
                (
                    filePath: string,
                    encoding: null,
                    callback: (?Error, ?string) => void,
                ) => {
                    callback(new Error("Should not be called"));
                },
            );

        // Act
        const valueMatches = await matches(rootLogger, "sekret");

        // Assert
        assert.isTrue(valueMatches, "Should match secret value ");
    });
});
