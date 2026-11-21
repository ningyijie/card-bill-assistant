import type { EmailAccount } from '../api/types';

export function groupEmailAccounts(accounts: EmailAccount[]): Map<string, EmailAccount[]> {
  const groups = new Map<string, EmailAccount[]>();
  for (const account of accounts) {
    const key = account.email.trim().toLowerCase();
    const group = groups.get(key);
    if (group) group.push(account);
    else groups.set(key, [account]);
  }
  return groups;
}

export function mailboxPath(account: EmailAccount): string {
  return account.mailbox || 'INBOX';
}

export function folderName(account: EmailAccount): string {
  const mailbox = mailboxPath(account);
  return mailbox === 'INBOX' ? '收件箱（INBOX）' : mailbox;
}
