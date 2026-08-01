function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeComparable(value) {
  return normalizeText(value).toLowerCase();
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function officialAliases(account) {
  return [
    account.account_name,
    ...parseJsonArray(account.aliases).map(value => typeof value === 'string' ? value : value?.name),
  ].map(normalizeComparable).filter(Boolean);
}

function platformCompatible(subject, account) {
  return !(account.platform && subject.platform && account.platform !== subject.platform);
}

function officialStrongIdentity(account) {
  return {
    platformUserId: normalizeComparable(account.platform_user_id || ''),
    accountNo: normalizeComparable(account.account_no || ''),
    legacyAccountId: normalizeComparable(account.account_id || ''),
  };
}

function subjectStrongIdentity(subject) {
  return {
    platformUserId: normalizeComparable(
      subject.author_id || subject.platform_user_id || '',
    ),
    accountNo: normalizeComparable(
      subject.author_account_no || subject.account_no || '',
    ),
  };
}

function matchesStrongOfficialIdentity(subject, account) {
  const subjectIdentity = subjectStrongIdentity(subject);
  const officialIdentity = officialStrongIdentity(account);
  if (
    subjectIdentity.platformUserId &&
    officialIdentity.platformUserId &&
    subjectIdentity.platformUserId === officialIdentity.platformUserId
  ) return true;
  if (
    subjectIdentity.accountNo &&
    officialIdentity.accountNo &&
    subjectIdentity.accountNo === officialIdentity.accountNo
  ) return true;
  return Boolean(
    officialIdentity.legacyAccountId &&
    (
      subjectIdentity.platformUserId === officialIdentity.legacyAccountId ||
      subjectIdentity.accountNo === officialIdentity.legacyAccountId
    ),
  );
}

export function matchesOfficialRecordOwner(subject, account) {
  if (!account || account.status !== 'active') return false;
  if (!platformCompatible(subject, account)) return false;
  return matchesStrongOfficialIdentity(subject, account);
}

export function matchesOfficialCommentAuthor(subject, account) {
  if (!account || account.status !== 'active') return false;
  if (!platformCompatible(subject, account)) return false;
  if (matchesStrongOfficialIdentity(subject, account)) return true;
  const officialIdentity = officialStrongIdentity(account);
  const subjectIdentity = subjectStrongIdentity(subject);
  if (
    officialIdentity.platformUserId ||
    officialIdentity.accountNo ||
    officialIdentity.legacyAccountId ||
    subjectIdentity.platformUserId ||
    subjectIdentity.accountNo
  ) return false;
  const subjectName = normalizeComparable(subject.author_name || subject.account_name || '');
  if (!subjectName) return false;
  return officialAliases(account).some(alias => alias && subjectName === alias);
}

function hasContradictoryStrongIdentity(subject, account) {
  const subjectIdentity = subjectStrongIdentity(subject);
  const officialIdentity = officialStrongIdentity(account);
  if (
    subjectIdentity.platformUserId &&
    officialIdentity.platformUserId &&
    subjectIdentity.platformUserId !== officialIdentity.platformUserId
  ) return true;
  if (
    subjectIdentity.accountNo &&
    officialIdentity.accountNo &&
    subjectIdentity.accountNo !== officialIdentity.accountNo
  ) return true;
  return false;
}

// 官方巡查任务已在服务端绑定到唯一 official_account。任务回传记录仍需平台兼容、
// 名称命中且强身份不矛盾；这样可以填补账号强 ID 暂时缺失的窗口，又不会把普通同名采集误判。
export function matchesExecutionBoundOfficialRecordOwner(subject, account) {
  if (!account || account.status !== 'active' || account.execution_bound !== true) return false;
  if (!platformCompatible(subject, account)) return false;
  if (matchesStrongOfficialIdentity(subject, account)) return true;
  if (hasContradictoryStrongIdentity(subject, account)) return false;
  const subjectName = normalizeComparable(subject.author_name || subject.account_name || '');
  if (!subjectName) return false;
  return officialAliases(account).some(alias => alias && subjectName === alias);
}

export function findOfficialRecordOwner(subject, accounts = []) {
  return accounts.find(account => matchesOfficialRecordOwner(subject, account)) || null;
}

export function findOfficialCommentAuthor(subject, accounts = []) {
  return accounts.find(account => matchesOfficialCommentAuthor(subject, account)) || null;
}

export function findCapturedOfficialRecordOwner(subject, accounts = []) {
  const strongMatch = findOfficialRecordOwner(subject, accounts);
  if (strongMatch) {
    return {
      account: strongMatch,
      source: strongMatch.execution_bound === true
        ? 'official_patrol_execution'
        : 'strong_identity',
    };
  }
  const executionMatch = accounts.find(account =>
    matchesExecutionBoundOfficialRecordOwner(subject, account));
  if (executionMatch) return {account: executionMatch, source: 'official_patrol_execution'};
  return {account: null, source: ''};
}

export function resolveCapturedRecordType({record = {}, existing = {}, officialAccounts = []} = {}) {
  const incomingRecordType = normalizeText(record.record_type) ||
    normalizeText(existing.record_type) || 'single_note';
  const existingRecordType = normalizeText(existing.record_type);

  // 账号主页资料不是一篇发文，继续保留独立类型。
  if (incomingRecordType === 'blogger_profile' || existingRecordType === 'blogger_profile') {
    return {
      recordType: 'blogger_profile',
      incomingRecordType,
      officialContent: false,
      officialAccount: null,
      source: 'profile_record',
    };
  }

  const owner = findCapturedOfficialRecordOwner(record, officialAccounts);
  // 官方巡查任务属于租户级官方社媒流程，不受某台 Extension 的本地采集偏好反向覆盖。
  // 普通手工采集仍尊重 skip_official_accounts=false。
  const captureExclusionEnabled = record.skip_official_accounts !== false ||
    owner.source === 'official_patrol_execution';
  if (
    captureExclusionEnabled &&
    owner.account &&
    owner.account.skip_content !== false
  ) {
    return {
      recordType: 'official_content',
      incomingRecordType,
      officialContent: true,
      officialAccount: owner.account,
      source: owner.source,
    };
  }

  // 只有明确关闭本次采集排除，或已匹配账号明确关闭 skip_content，才允许重新进入普通内容。
  if (!captureExclusionEnabled || (owner.account && owner.account.skip_content === false)) {
    return {
      recordType: incomingRecordType === 'official_content' ? 'single_note' : incomingRecordType,
      incomingRecordType,
      officialContent: false,
      officialAccount: owner.account,
      source: !captureExclusionEnabled ? 'capture_exclusion_disabled' : 'account_exclusion_disabled',
    };
  }

  // 已确认的官方内容在账号身份短暂缺失时保持隐藏，避免一次普通 blogger_notes 重采把它降级。
  if (existingRecordType === 'official_content') {
    return {
      recordType: 'official_content',
      incomingRecordType,
      officialContent: true,
      officialAccount: null,
      source: 'preserved_official_content',
    };
  }

  return {
    recordType: incomingRecordType,
    incomingRecordType,
    officialContent: incomingRecordType === 'official_content',
    officialAccount: owner.account,
    source: owner.source || 'ordinary_content',
  };
}
