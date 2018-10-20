import * as fs from "fs";
import { EOL } from "os";
import { join } from "path";
import { promisify } from "util";

import * as Octokit from "@octokit/rest";
import * as execa from "execa";
import * as tempy from "tempy";

import {
  CommitMessage,
  createTemporaryReference,
  fetchReferenceSha,
  PullRequestNumber,
  Reference,
  RepoName,
  RepoOwner,
  Sha,
} from "../git";

type CommitContent = string;

type CommitLines = string[];

type Commit = { lines: CommitLines; message: CommitMessage };

type ReferenceState = Commit[];

type RepoState = {
  initialCommit: Commit;
  refsCommits: {
    [reference: string]: ReferenceState;
  };
};

type CommandArgs = string[];

type CommandDirectory = string;

type CommandEnv = { [key: string]: string };

type DeleteReferences = () => Promise<void>;

type RefsDetails = { [reference: string]: { ref: Reference; shas: Sha[] } };

const lineSeparator = `${EOL}${EOL}`;
const filename = "file.txt";

const readFile = promisify(fs.readFile);
const writeFile = promisify(fs.writeFile);

const getContent = (lines: CommitLines) => lines.join(lineSeparator);
const getLines = (content: CommitContent) => content.split(lineSeparator);

const createBlob = async ({
  content,
  octokit,
  owner,
  repo,
}: {
  content: CommitContent;
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
}) => {
  const {
    data: { sha },
  } = await octokit.gitdata.createBlob({
    content,
    owner,
    repo,
  });
  return sha;
};

const createTree = async ({
  blob,
  octokit,
  owner,
  repo,
}: {
  blob: Sha;
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
}) => {
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
}: {
  message: CommitMessage;
  octokit: Octokit;
  owner: RepoOwner;
  parent?: Sha;
  repo: RepoName;
  tree: Sha;
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
  commit: Commit;
  octokit: Octokit;
  owner: RepoOwner;
  parent?: Sha;
  repo: RepoName;
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
  base: Reference;
  head: Reference;
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
}): Promise<PullRequestNumber> => {
  const {
    data: { number: pullRequestNumber },
  } = await octokit.pullRequests.create({
    base,
    head,
    owner,
    repo,
    title: "Untitled",
  });
  return pullRequestNumber;
};

const fetchContent = async ({
  octokit,
  owner,
  repo,
  ref,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
  ref: Reference;
}) => {
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
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
  sha: Sha;
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
  octokit: Octokit;
  owner: RepoOwner;
  ref: Reference;
  repo: RepoName;
}): Promise<ReferenceState> => {
  const sha = await fetchReferenceSha({
    octokit,
    owner,
    ref,
    repo,
  });
  return fetchReferenceCommitsFromSha({ octokit, owner, repo, sha });
};

const getLatestSha = (shas: Sha[]) => shas[shas.length - 1];

const internalCreateReferences = async ({
  octokit,
  owner,
  repo,
  state: { initialCommit, refsCommits },
}: {
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
  state: RepoState;
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
        Promise.resolve([initialCommitSha]),
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
    }),
  );
};

const createReferences = async ({
  octokit,
  owner,
  repo,
  state: { initialCommit, refsCommits },
}: {
  octokit: Octokit;
  owner: RepoOwner;
  repo: RepoName;
  state: RepoState;
}): Promise<{
  deleteReferences: DeleteReferences;
  refsDetails: RefsDetails;
}> => {
  const refNames = Object.keys(refsCommits);

  const refsDetails = await internalCreateReferences({
    octokit,
    owner,
    repo,
    state: { initialCommit, refsCommits },
  });

  return {
    async deleteReferences() {
      await Promise.all(
        refsDetails.map(({ deleteReference }) => deleteReference()),
      );
    },
    refsDetails: refsDetails.reduce(
      (acc, { shas, temporaryRef }, index) =>
        Object.assign({}, acc, {
          [refNames[index]]: { ref: temporaryRef, shas },
        }),
      {},
    ),
  };
};

const executeGitCommandInCurrentReference = ({
  args,
  directory,
  env,
}: {
  args: CommandArgs;
  directory: CommandDirectory;
  env?: CommandEnv;
}) => execa.stdout("git", args, { cwd: directory, env });

const checkout = ({
  directory,
  reference,
}: {
  directory: CommandDirectory;
  reference: Reference;
}) =>
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
  args: CommandArgs;
  directory: CommandDirectory;
  env?: CommandEnv;
  reference: Reference;
}) => {
  await checkout({ directory, reference });
  return executeGitCommandInCurrentReference({ args, directory, env });
};

const createGitRepoCommit = async ({
  commit: { lines, message },
  directory,
}: {
  commit: Commit;
  directory: CommandDirectory;
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
    await (reference === "master"
      ? Promise.resolve()
      : executeGitCommandInCurrentReference({
          args: ["checkout", "-b", reference],
          directory,
        }));
  }, Promise.resolve());
  await references.reduce(async (referencePromise, reference) => {
    await referencePromise;
    await checkout({ directory, reference });
    await refsCommits[reference].reduce(async (commitPromise, commit) => {
      await commitPromise;
      await createGitRepoCommit({ commit, directory });
    }, Promise.resolve());
  }, Promise.resolve());
  return directory;
};

const getReferenceShasFromGitRepo = async ({
  directory,
  reference,
}: {
  directory: CommandDirectory;
  reference: Reference;
}): Promise<Sha[]> => {
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
  directory: CommandDirectory;
  reference: Reference;
}): Promise<ReferenceState> => {
  const shas = await getReferenceShasFromGitRepo({ directory, reference });
  const initialCommits: Commit[] = [];
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
  }, Promise.resolve(initialCommits));
};

export {
  CommandDirectory,
  createCommitFromLinesAndMessage,
  createGitRepo,
  createPullRequest,
  createReferences,
  DeleteReferences,
  executeGitCommand,
  fetchReferenceCommits,
  fetchReferenceCommitsFromSha,
  getReferenceCommitsFromGitRepo,
  getReferenceShasFromGitRepo,
  RefsDetails,
  RepoState,
};
