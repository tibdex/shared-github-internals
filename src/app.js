// @flow strict

/* eslint-env node */

import Octokit from "@octokit/rest";
import envalid from "envalid";
import jwt from "jsonwebtoken";

type GithubAppId = number;

type GithubInstallationId = number;

/**
 * GitHub App RSA private key.
 */
type PrivateKey = string;

const createAuthenticatedOctokit = async ({
  appId,
  installationId,
  privateKey
}: {
  appId: GithubAppId,
  installationId: GithubInstallationId,
  privateKey: PrivateKey
}): Octokit => {
  const octokit = new Octokit();
  octokit.authenticate({
    token: jwt.sign({ iss: appId }, privateKey, {
      algorithm: "RS256",
      expiresIn: "10s"
    }),
    type: "app"
  });
  const {
    data: { token }
  } = await octokit.apps.createInstallationToken({
    installation_id: installationId
  });
  octokit.authenticate({ token, type: "token" });
  return octokit;
};

const getConfig = (env: {}): { appId: GithubAppId, privateKey: PrivateKey } => {
  const {
    APP_ID: appId,
    BASE64_ENCODED_PRIVATE_KEY: privateKey
  } = envalid.cleanEnv(
    env,
    {
      APP_ID: envalid.num({
        desc: "The GitHub App ID",
        docs:
          "https://developer.github.com/apps/building-github-apps/authenticating-with-github-apps/#authenticating-as-a-github-app"
      }),
      BASE64_ENCODED_PRIVATE_KEY: envalid.makeValidator(base64string => {
        const utf8string = Buffer.from(base64string, "base64").toString("utf8");
        if (
          !/-----BEGIN RSA PRIVATE KEY-----[\s\S]+-----END RSA PRIVATE KEY-----/mu.test(
            utf8string
          )
        ) {
          throw new Error("invalid GitHub App RSA private key");
        }
        return utf8string;
      })({
        desc:
          "The GitHub App private key encoded in base64 in order not to deal with cumbersome EOL escaping",
        docs:
          "https://developer.github.com/apps/building-integrations/setting-up-and-registering-github-apps/registering-github-apps/#generating-a-private-key"
      })
    },
    { strict: true }
  );
  return { appId, privateKey };
};

export { createAuthenticatedOctokit, getConfig };
