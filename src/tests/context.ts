import * as Octokit from "@octokit/rest";
import * as envalid from "envalid";

import { RepoName, RepoOwner } from "../git";

type TestContext = {
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
};

const createTestContext = (): TestContext => {
  const env = envalid.cleanEnv(
    // eslint-disable-next-line no-process-env
    process.env,
    {
      GITHUB_PERSONAL_ACCESS_TOKEN: envalid.str({
        desc: "The token must grant read/write access to the test repository.",
        docs: "https://github.com/settings/tokens",
      }),
      GITHUB_TEST_REPOSITORY_NAME: envalid.str({
        desc: "Name of the repository against which the tests will be run",
      }),
      GITHUB_TEST_REPOSITORY_OWNER: envalid.str({
        desc: "Owner of the repository against which the tests will be run.",
      }),
    },
    { strict: true },
  );

  const repo = env.GITHUB_TEST_REPOSITORY_NAME;
  const owner = env.GITHUB_TEST_REPOSITORY_OWNER;

  const octokit = new Octokit();
  octokit.authenticate({
    token: env.GITHUB_PERSONAL_ACCESS_TOKEN,
    type: "token",
  });

  return { octokit, owner, repo };
};

export { createTestContext, TestContext };
