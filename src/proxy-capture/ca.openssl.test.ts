import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as systemBin from "../infra/resolve-system-bin.js";
import { ensureDebugProxyCa, ensureSecretEgressProxyCa, generateLocalProxyLeaf } from "./ca.js";

const run = promisify(execFile);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const systemOpenSsl = systemBin.resolveSystemBin("openssl");
const opensslBins = [
  ...new Set([
    systemOpenSsl,
    ...(process.platform === "darwin" && existsSync("/opt/homebrew/bin/openssl")
      ? ["/opt/homebrew/bin/openssl"]
      : []),
  ]),
].filter((binary): binary is string => binary !== null);

afterEach(() => vi.restoreAllMocks());

describe.skipIf(opensslBins.length === 0)("local proxy certificate compatibility", () => {
  describe.each(opensslBins)("generated with %s", (openssl) => {
    beforeEach(() => {
      vi.spyOn(systemBin, "resolveSystemBin").mockReturnValue(openssl);
    });

    it("emits key identifiers and a chain accepted by strict TLS verification", async () => {
      const certDir = tempDirs.make("openclaw-proxy-ca-strict-");
      const ca = await ensureSecretEgressProxyCa(certDir);
      const leaf = await generateLocalProxyLeaf({ certDir, ca, hostname: "api.example.com" });
      const leafPath = path.join(certDir, "verify-leaf.pem");
      await fs.writeFile(leafPath, leaf.cert);
      const issuer = await run(openssl, ["x509", "-in", ca.certPath, "-noout", "-text"]);
      const issued = await run(openssl, ["x509", "-in", leafPath, "-noout", "-text"]);
      expect(issuer.stdout).toContain("Subject Key Identifier");
      expect(issued.stdout).toContain("Subject Key Identifier");
      expect(issued.stdout).toContain("Authority Key Identifier");
      const verified = await run(openssl, [
        "verify",
        "-x509_strict",
        "-purpose",
        "sslserver",
        "-CAfile",
        ca.certPath,
        leafPath,
      ]);
      expect(verified.stdout).toContain(": OK");
    });

    it("keeps a retained CA without a subject key identifier usable and unchanged", async () => {
      const certDir = tempDirs.make("openclaw-proxy-ca-retained-");
      const ca = {
        certPath: path.join(certDir, "root-ca.pem"),
        keyPath: path.join(certDir, "root-ca-key.pem"),
      };
      const configPath = path.join(certDir, "retained.cnf");
      const version = await run(openssl, ["version"]);
      const opensslVersion = /^OpenSSL (\d+)\.(\d+)\./.exec(version.stdout);
      const supportsNoKeyId =
        opensslVersion &&
        (Number(opensslVersion[1]) > 3 ||
          (Number(opensslVersion[1]) === 3 && Number(opensslVersion[2]) >= 2));
      await fs.writeFile(
        configPath,
        [
          "[req]",
          "distinguished_name = subject",
          "prompt = no",
          "[subject]",
          "CN = Retained Test Proxy",
          "[v3_ca]",
          "basicConstraints = critical, CA:TRUE",
          "keyUsage = critical, keyCertSign, cRLSign",
          // OpenSSL 3.2+ can add SKI automatically; older OpenSSL/LibreSSL reject `none`.
          ...(supportsNoKeyId ? ["subjectKeyIdentifier = none"] : []),
          "",
        ].join("\n"),
      );
      await run(openssl, [
        "req",
        "-config",
        configPath,
        "-extensions",
        "v3_ca",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-days",
        "1",
        "-nodes",
        "-keyout",
        ca.keyPath,
        "-out",
        ca.certPath,
      ]);
      const issuer = await run(openssl, ["x509", "-in", ca.certPath, "-noout", "-text"]);
      expect(issuer.stdout).not.toContain("Subject Key Identifier");
      const retainedCert = await fs.readFile(ca.certPath);
      const retainedKey = await fs.readFile(ca.keyPath);
      await expect(ensureDebugProxyCa(certDir)).resolves.toEqual(ca);
      const leaf = await generateLocalProxyLeaf({ certDir, ca, hostname: "api.example.com" });
      const leafPath = path.join(certDir, "retained-leaf.pem");
      await fs.writeFile(leafPath, leaf.cert);
      const issued = await run(openssl, ["x509", "-in", leafPath, "-noout", "-text"]);
      expect(issued.stdout).toContain("Authority Key Identifier");
      const verified = await run(openssl, ["verify", "-CAfile", ca.certPath, leafPath]);
      expect(verified.stdout).toContain(": OK");
      expect(await fs.readFile(ca.certPath)).toEqual(retainedCert);
      expect(await fs.readFile(ca.keyPath)).toEqual(retainedKey);
    });
  });
});
