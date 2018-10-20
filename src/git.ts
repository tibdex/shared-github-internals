import * as Octokit from "@octokit/rest";
import * as generateUuid from "uuid/v4";

type PullRequestNumber = number;

/**
 * A Git reference name.
 */
type Reference = string;

type RepoName = string;

type RepoOwner = string;

/**
 * A Git SHA-1.
 */
type Sha = string;

type CommitMessage = string;

type CommitAuthor = {};

type CommitCommitter = {};

type CommitDetails = {
  author: CommitAuthor;
  committer: CommitCommitter;
  message: CommitMessage;
  sha: Sha;
  tree: Sha;
};

const generateUniqueRef = (ref: Reference): Reference =>
  `${ref}-${generateUuid()}`;
const getHeadRef = (ref: Reference): Reference => `heads/${ref}`;
const getFullyQualifiedRef = (ref: Reference): Reference =>
  `refs/${getHeadRef(ref)}`;

const fetchReferenceSha = async ({
  octokit,
  owner,
  ref,
  repo,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  ref: Reference;
  repo: RepoName;
}): Promise<Sha> => {
  const {
    data: {
      object: { sha },
    },
  } = await octokit.gitdata.getReference({
    owner,
    ref: getHeadRef(ref),
    repo,
  });
  return sha;
};

const updateReference = async ({
  force,
  octokit,
  owner,
  ref,
  repo,
  sha,
}: {
  force: boolean;
  octokit: Octokit;
  owner: RepoOwner;
  ref: Reference;
  repo: RepoName;
  sha: Sha;
}): Promise<void> => {
  await octokit.gitdata.updateReference({
    force,
    owner,
    ref: getHeadRef(ref),
    repo,
    sha,
  });
};

const deleteReference = async ({
  octokit,
  owner,
  ref,
  repo,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  ref: Reference;
  repo: RepoName;
}): Promise<void> => {
  await octokit.gitdata.deleteReference({
    owner,
    ref: getHeadRef(ref),
    repo,
  });
};

const createReference = async ({
  octokit,
  owner,
  ref,
  repo,
  sha,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  ref: Reference;
  repo: RepoName;
  sha: Sha;
}): Promise<void> => {
  await octokit.gitdata.createReference({
    owner,
    ref: getFullyQualifiedRef(ref),
    repo,
    sha,
  });
};

const createTemporaryReference = async ({
  octokit,
  owner,
  ref,
  repo,
  sha,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  ref: Reference;
  repo: RepoName;
  sha: Sha;
}): Promise<{
  deleteTemporaryReference: () => Promise<void>;
  temporaryRef: Reference;
}> => {
  const temporaryRef = generateUniqueRef(ref);
  await createReference({
    octokit,
    owner,
    ref: temporaryRef,
    repo,
    sha,
  });
  return {
    async deleteTemporaryReference() {
      await deleteReference({
        octokit,
        owner,
        ref: temporaryRef,
        repo,
      });
    },
    temporaryRef,
  };
};

const withTemporaryReference = async <T>({
  action,
  octokit,
  owner,
  ref,
  repo,
  sha,
}: {
  action: (reference: Reference) => Promise<T>;
  octokit: Octokit;
  owner: RepoOwner;
  ref: Reference;
  repo: RepoName;
  sha: Sha;
}): Promise<T> => {
  const {
    deleteTemporaryReference,
    temporaryRef,
  } = await createTemporaryReference({
    octokit,
    owner,
    ref,
    repo,
    sha,
  });

  try {
    return await action(temporaryRef);
  } finally {
    await deleteTemporaryReference();
  }
};

const getCommitsDetails = (
  response: Octokit.Response<Octokit.PullRequestsGetCommitsResponse>,
) =>
  response.data.map(
    ({
      commit: {
        author,
        committer,
        message,
        tree: { sha: tree },
      },
      sha,
    }) => ({
      author,
      committer,
      message,
      sha,
      tree,
    }),
  );

const fetchCommitsDetails = async ({
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}): Promise<CommitDetails[]> => {
  let response = await octokit.pullRequests.getCommits({
    number: pullRequestNumber,
    owner,
    repo,
  });
  const details = getCommitsDetails(response);
  while (octokit.hasNextPage(response)) {
    // Pagination is a legit use-case for using await in loops.
    // See https://github.com/octokit/rest.js#pagination
    // eslint-disable-next-line no-await-in-loop
    response = await octokit.getNextPage(response);
    details.push(...getCommitsDetails(response));
  }
  return details;
};

const fetchCommits = async ({
  octokit,
  owner,
  pullRequestNumber,
  repo,
}: {
  octokit: Octokit;
  owner: RepoOwner;
  pullRequestNumber: PullRequestNumber;
  repo: RepoName;
}): Promise<Sha[]> => {
  const details = await fetchCommitsDetails({
    octokit,
    owner,
    pullRequestNumber,
    repo,
  });
  return details.map(({ sha }) => sha);
};

export {
  CommitAuthor,
  CommitCommitter,
  CommitMessage,
  CommitDetails,
  PullRequestNumber,
  Reference,
  RepoName,
  RepoOwner,
  Sha,
  createReference,
  createTemporaryReference,
  deleteReference,
  fetchCommits,
  fetchCommitsDetails,
  fetchReferenceSha,
  generateUniqueRef,
  getHeadRef,
  updateReference,
  withTemporaryReference,
};
