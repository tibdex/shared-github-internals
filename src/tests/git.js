// @flow strict

import fs from "fs";
import { EOL } from "os";
import { join } from "path";
import { promisify } from "util";

import { type Github } from "@octokit/rest";
import execa from "execa";
import tempy from "tempy";

import {
  type CommitMessage,
  type PullRequestNumber,
  type Reference,
  type RepoName,
  type RepoOwner,
  type Sha,
  createTemporaryReference,
  fetchReferenceSha,
} from "../git";

type CommitLines = Array<string>;

type Commit = { lines: CommitLines, message: CommitMessage };

type ReferenceState = Array<Commit>;

type RepoState = {
  initialCommit: Commit,
  refsCommits: {
    [Reference]: ReferenceState,
  },
};

type CommandArgs = Array<string>;

type CommandDirectory = string;

type CommandEnv = { [string]: string };

const lineSeparator = `${EOL}${EOL}`;
const filename = "file.txt";

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

const getContent = lines => lines.join(lineSeparator);
const getLines = content => content.split(lineSeparator);

const createBlob = async ({ content, octokit, owner, repo }) => {
  const {
    data: { sha },
  } = await octokit.gitdata.createBlob({
    content,
    owner,
    repo,
  });
  return sha;
};

const createTree = async ({ blob, octokit, owner, repo }) => {
  const {
    data: { sha: treeSha },
  } = await octokit.gitdata.createTree({
    owner,
    repo,
    tree: [
      {
        mode: "100644",
        path: filename,
        sha: blob,
        type: "blob",
      },
    ],
  });
  return treeSha;
};

const createCommit = async ({
  message,
  octokit,
  owner,
  parent,
  repo,
  tree,
}) => {
  const {
    data: { sha },
  } = await octokit.gitdata.createCommit({
    message,
    owner,
    parents: parent == null ? [] : [parent],
    repo,
    tree,
  });
  return sha;
};

const createCommitFromLinesAndMessage = async ({
  commit: { lines, message },
  octokit,
  owner,
  parent,
  repo,
}: {
  commit: Commit,
  octokit: Github,
  owner: RepoOwner,
  parent?: Sha,
  repo: RepoName,
}): Promise<Sha> => {
  const content = getContent(lines);
  const blob = await createBlob({ content, octokit, owner, repo });
  const tree = await createTree({ blob, octokit, owner, repo });
  return createCommit({
    message,
    octokit,
    owner,
    parent,
    repo,
    tree,
  });
};

const createPullRequest = async ({
  base,
  head,
  octokit,
  owner,
  repo,
}: {
  base: Reference,
  head: Reference,
  octokit: Github,
  owner: RepoOwner,
  repo: RepoName,
}): Promise<PullRequestNumber> => {
  const {
    data: { number },
  } = await octokit.pullRequests.create({
    base,
    head,
    owner,
    repo,
    title: "Untitled",
  });
  return number;
};

const fetchContent = async ({ octokit, owner, repo, ref }) => {
  const {
    data: { content, encoding },
  } = await octokit.repos.getContent({
    owner,
    path: filename,
    ref,
    repo,
  });
  return Buffer.from(content, encoding).toString("utf8");
};

const fetchReferenceCommitsFromSha = async ({
  octokit,
  owner,
  repo,
  sha,
}: {
  octokit: Github,
  owner: RepoOwner,
  repo: RepoName,
  sha: Sha,
}): Promise<ReferenceState> => {
  const content = await fetchContent({ octokit, owner, ref: sha, repo });

  const {
    data: { message, parents },
  } = await octokit.gitdata.getCommit({ commit_sha: sha, owner, repo });

  const commit = { lines: getLines(content), message };

  if (parents.length !== 0) {
    const commits = await fetchReferenceCommitsFromSha({
      octokit,
      owner,
      repo,
      sha: parents[0].sha,
    });
    return [...commits, commit];
  }

  return [commit];
};

const fetchReferenceCommits = async ({
  octokit,
  owner,
  ref,
  repo,
}: {
  octokit: Github,
  owner: RepoOwner,
  ref: Reference,
  repo: RepoName,
}): Promise<ReferenceState> => {
  const sha = await fetchReferenceSha({
    octokit,
    owner,
    ref,
    repo,
  });
  return fetchReferenceCommitsFromSha({ octokit, owner, repo, sha });
};

const getLatestSha = shas => shas[shas.length - 1];

const internalCreateReferences = async ({
  octokit,
  owner,
  repo,
  state: { initialCommit, refsCommits },
}) => {
  const initialCommitSha = await createCommitFromLinesAndMessage({
    commit: initialCommit,
    octokit,
    owner,
    repo,
  });

  const refNames = Object.keys(refsCommits);

  return Promise.all(
    refNames.map(async ref => {
      const shas = await refsCommits[ref].reduce(
        async (parentPromise, commit) => {
          const accumulatedShas = await parentPromise;
          const sha = await createCommitFromLinesAndMessage({
            commit,
            octokit,
            owner,
            parent: getLatestSha(accumulatedShas),
            repo,
          });
          return [...accumulatedShas, sha];
        },
        Promise.resolve([initialCommitSha])
      );
      const {
        deleteTemporaryReference: deleteReference,
        temporaryRef,
      } = await createTemporaryReference({
        octokit,
        owner,
        ref,
        repo,
        sha: getLatestSha(shas),
      });
      return { deleteReference, shas, temporaryRef };
    })
  );
};

const createReferences = async ({
  octokit,
  owner,
  repo,
  state: { initialCommit, refsCommits },
}: {
  octokit: Github,
  owner: RepoOwner,
  repo: RepoName,
  state: RepoState,
}): Promise<{
  deleteReferences: () => Promise<void>,
  refsDetails: { [Reference]: { ref: Reference, shas: Array<Sha> } },
}> => {
  const refNames = Object.keys(refsCommits);

  const refsDetails = await internalCreateReferences({
    octokit,
    owner,
    refsCommits,
    repo,
    state: { initialCommit, refsCommits },
  });

  return {
    async deleteReferences() {
      await Promise.all(
        refsDetails.map(({ deleteReference }) => deleteReference())
      );
    },
    refsDetails: refsDetails.reduce(
      (acc, { shas, temporaryRef }, index) =>
        Object.assign({}, acc, {
          [refNames[index]]: { ref: temporaryRef, shas },
        }),
      {}
    ),
  };
};

const executeGitCommandInCurrentReference = ({
  args,
  directory,
  env,
}: {
  args: CommandArgs,
  directory: CommandDirectory,
  env?: CommandEnv,
}) => execa.stdout("git", args, { cwd: directory, env });

const checkout = ({ directory, reference }) =>
  executeGitCommandInCurrentReference({
    args: ["checkout", reference],
    directory,
  });

const executeGitCommand = async ({
  args,
  directory,
  env,
  reference,
}: {
  args: CommandArgs,
  directory: CommandDirectory,
  env?: CommandEnv,
  reference: Reference,
}) => {
  await checkout({ directory, reference });
  return executeGitCommandInCurrentReference({ args, directory, env });
};

const createGitRepoCommit = async ({
  commit: { lines, message },
  directory,
}) => {
  await writeFile(join(directory, filename), getContent(lines));
  await executeGitCommandInCurrentReference({
    args: ["add", filename],
    directory,
  });
  await executeGitCommandInCurrentReference({
    args: ["commit", "--message", message],
    directory,
  });
};

const createGitRepo = async ({ initialCommit, refsCommits }: RepoState) => {
  const directory = tempy.directory();
  await executeGitCommandInCurrentReference({ args: ["init"], directory });
  await createGitRepoCommit({ commit: initialCommit, directory });
  const references = Object.keys(refsCommits);
  await references.reduce(async (referencePromise, reference) => {
    await referencePromise;
    return reference === "master"
      ? Promise.resolve()
      : executeGitCommandInCurrentReference({
          args: ["checkout", "-b", reference],
          directory,
        });
  }, Promise.resolve());
  await references.reduce(async (referencePromise, reference) => {
    await referencePromise;
    await checkout({ directory, reference });
    return refsCommits[reference].reduce(async (commitPromise, commit) => {
      await commitPromise;
      return createGitRepoCommit({ commit, directory });
    }, Promise.resolve());
  }, Promise.resolve());
  return directory;
};

const getReferenceShasFromGitRepo = async ({
  directory,
  reference,
}: {
  directory: CommandDirectory,
  reference: Reference,
}): Promise<Array<Sha>> => {
  const log = await executeGitCommand({
    args: ["log", "--pretty=format:%h"],
    directory,
    reference,
  });
  return log.split("\n").reverse();
};

const getReferenceCommitsFromGitRepo = async ({
  directory,
  reference,
}: {
  directory: CommandDirectory,
  reference: Reference,
}): Promise<ReferenceState> => {
  const shas = await getReferenceShasFromGitRepo({ directory, reference });
  return shas.reduce(async (waitForCommits, sha) => {
    const commits = await waitForCommits;
    await executeGitCommandInCurrentReference({
      args: ["checkout", sha],
      directory,
    });
    const [content, message] = await Promise.all([
      readFile(join(directory, filename)),
      executeGitCommandInCurrentReference({
        args: ["log", "--format=%B", "--max-count", "1"],
        directory,
      }),
    ]);
    return [
      ...commits,
      {
        lines: getLines(String(content)),
        message: message.trim(),
      },
    ];
  }, Promise.resolve([]));
};

export type { CommandDirectory, RepoState };

export {
  createCommitFromLinesAndMessage,
  createGitRepo,
  createPullRequest,
  createReferences,
  executeGitCommand,
  fetchReferenceCommits,
  fetchReferenceCommitsFromSha,
  getReferenceCommitsFromGitRepo,
  getReferenceShasFromGitRepo,
};
