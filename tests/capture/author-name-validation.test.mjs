import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveAuthorProfileIdentity,
  validateAuthorName,
  validateCapturedData,
} from "../../utils/capture/single-note.js";

const verifiedNumericAuthor = {
  fromAuthorContainer: true,
  profileUrl:
    "https://www.xiaohongshu.com/user/profile/668e7f3f0000000003021234?xsec_token=test",
  userId: "668e7f3f0000000003021234",
};
const profileBoundAuthor = {
  ...verifiedNumericAuthor,
  nameFromProfileLink: true,
};

class FakeAuthorNode {
  constructor({className = "", href = ""} = {}) {
    this.className = className;
    this.href = href;
    this.parentElement = null;
    this.children = [];
  }

  append(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  contains(candidate) {
    return (
      candidate === this ||
      this.children.some((child) => child.contains(candidate))
    );
  }

  closest(selector) {
    let current = this;
    while (current) {
      if (
        selector === 'a[href*="/user/profile/"]' &&
        current.href.includes("/user/profile/")
      ) {
        return current;
      }
      if (
        selector.startsWith(".") &&
        current.className.split(/\s+/u).includes(selector.slice(1))
      ) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }

  querySelectorAll(selector) {
    const descendants = this.children.flatMap((child) => [
      child,
      ...child.querySelectorAll(selector),
    ]);
    if (selector === 'a[href*="/user/profile/"]') {
      return descendants.filter((node) => node.href.includes("/user/profile/"));
    }
    return [];
  }

  getAttribute(name) {
    return name === "href" ? this.href : null;
  }
}

test("accepts emoji-only social display names", () => {
  assert.equal(validateAuthorName("🌻"), true);
  assert.equal(validateAuthorName("✨"), true);
  assert.equal(validateAuthorName("🌻小红"), true);
  assert.equal(validateAuthorName("エコガ？エ"), true);
  assert.equal(validateAuthorName("한글 닉네임"), true);
});

test("still rejects non-name placeholders", () => {
  assert.equal(validateAuthorName("12345"), false);
  assert.equal(validateAuthorName("昨天 22:41"), false);
  assert.equal(validateAuthorName("..."), false);
  assert.equal(validateAuthorName("关注"), false);
  assert.equal(validateAuthorName("作者"), false);
});

test("profile-bound display text is preserved verbatim without language guessing", () => {
  assert.equal(validateAuthorName("...", profileBoundAuthor), true);
  assert.equal(validateAuthorName("作者", profileBoundAuthor), true);
  assert.equal(validateAuthorName("昨天 22:41", profileBoundAuthor), true);
});

test("accepts a numeric display name only with container-bound XHS profile identity", () => {
  assert.equal(validateAuthorName("123", verifiedNumericAuthor), true);
  assert.equal(
    validateAuthorName("123", {
      ...verifiedNumericAuthor,
      fromAuthorContainer: false,
    }),
    false,
  );
  assert.equal(
    validateAuthorName("123", {
      ...verifiedNumericAuthor,
      userId: "different-user-id",
    }),
    false,
  );
  assert.equal(
    validateAuthorName("123", {
      ...verifiedNumericAuthor,
      profileUrl:
        "https://xiaohongshu.com.evil.example/user/profile/668e7f3f0000000003021234",
    }),
    false,
  );
  assert.equal(
    validateAuthorName("123", {
      ...verifiedNumericAuthor,
      profileUrl: "https://www.xiaohongshu.com/explore/668e7f3f0000000003021234",
    }),
    false,
  );
});

test("derives numeric identity only from an unambiguous profile in the author container", () => {
  const authorContainer = new FakeAuthorNode({className: "author-wrapper"});
  const profileLink = authorContainer.append(
    new FakeAuthorNode({href: verifiedNumericAuthor.profileUrl}),
  );
  const nameElement = profileLink.append(new FakeAuthorNode());

  const identity = resolveAuthorProfileIdentity(
    authorContainer,
    nameElement,
    profileLink,
  );
  assert.deepEqual(identity, verifiedNumericAuthor);
  assert.equal(validateAuthorName("123", identity), true);

  const duplicateContainer = new FakeAuthorNode({className: "author-wrapper"});
  const duplicateName = duplicateContainer.append(new FakeAuthorNode());
  const duplicateProfile = duplicateContainer.append(
    new FakeAuthorNode({href: verifiedNumericAuthor.profileUrl}),
  );
  duplicateContainer.append(
    new FakeAuthorNode({
      href: `${verifiedNumericAuthor.profileUrl}&source=avatar`,
    }),
  );
  assert.deepEqual(
    resolveAuthorProfileIdentity(
      duplicateContainer,
      duplicateName,
      duplicateProfile,
    ),
    verifiedNumericAuthor,
  );

  const outsideProfileLink = new FakeAuthorNode({
    href: verifiedNumericAuthor.profileUrl,
  });
  const containerWithoutProfile = new FakeAuthorNode({
    className: "author-wrapper",
  });
  const containedName = containerWithoutProfile.append(new FakeAuthorNode());
  assert.deepEqual(
    resolveAuthorProfileIdentity(
      containerWithoutProfile,
      containedName,
      outsideProfileLink,
    ),
    {fromAuthorContainer: false, profileUrl: "", userId: ""},
  );

  const ambiguousContainer = new FakeAuthorNode({className: "author-wrapper"});
  const ambiguousName = ambiguousContainer.append(new FakeAuthorNode());
  ambiguousContainer.append(
    new FakeAuthorNode({href: verifiedNumericAuthor.profileUrl}),
  );
  ambiguousContainer.append(
    new FakeAuthorNode({
      href: "https://www.xiaohongshu.com/user/profile/another123",
    }),
  );
  assert.deepEqual(
    resolveAuthorProfileIdentity(ambiguousContainer, ambiguousName),
    {fromAuthorContainer: false, profileUrl: "", userId: ""},
  );

  const wrappedAmbiguousContainer = new FakeAuthorNode({
    className: "author-wrapper",
  });
  const wrappedProfile = wrappedAmbiguousContainer.append(
    new FakeAuthorNode({href: verifiedNumericAuthor.profileUrl}),
  );
  const wrappedName = wrappedProfile.append(new FakeAuthorNode());
  wrappedAmbiguousContainer.append(
    new FakeAuthorNode({
      href: "https://www.xiaohongshu.com/user/profile/another123",
    }),
  );
  assert.deepEqual(
    resolveAuthorProfileIdentity(
      wrappedAmbiguousContainer,
      wrappedName,
      wrappedProfile,
    ),
    {fromAuthorContainer: false, profileUrl: "", userId: ""},
  );

  const broadContainer = new FakeAuthorNode({className: "author-wrapper"});
  const comment = broadContainer.append(
    new FakeAuthorNode({className: "comment-item"}),
  );
  const commentProfile = comment.append(
    new FakeAuthorNode({href: verifiedNumericAuthor.profileUrl}),
  );
  const commentName = commentProfile.append(new FakeAuthorNode());
  assert.deepEqual(
    resolveAuthorProfileIdentity(
      broadContainer,
      commentName,
      commentProfile,
    ),
    {fromAuthorContainer: false, profileUrl: "", userId: ""},
  );
});

test("container identity without a profile-bound name cannot override placeholders", () => {
  const unboundIdentity = {
    ...profileBoundAuthor,
    nameFromProfileLink: false,
  };
  assert.equal(validateAuthorName("12天前", unboundIdentity), false);
  assert.equal(validateAuthorName("昨天 22:41", unboundIdentity), false);
  assert.equal(validateAuthorName("关注", unboundIdentity), false);
});

test("final payload requires matching profile identity for numeric authors only", () => {
  assert.equal(
    validateCapturedData({
      author: "123",
      authorId: verifiedNumericAuthor.userId,
      authorUrl: verifiedNumericAuthor.profileUrl,
      authorNameBoundToProfile: true,
    }),
    true,
  );
  assert.throws(
    () =>
      validateCapturedData({
        author: "123",
        authorId: "different-user-id",
        authorUrl: verifiedNumericAuthor.profileUrl,
        authorNameBoundToProfile: true,
      }),
    /纯数字作者身份不完整/u,
  );
  assert.equal(validateCapturedData({author: "普通作者"}), true);
});
