# Integrations

HomeVault can bring information in from the outside, so you do not retype it. Everything here is
**read-only** (nothing is ever written back to your calendar or bank), **owner-only** (only the people who
own a property can set it up or see bank data), and **optional** (`INTEGRATIONS_ENABLED=false` switches the
whole thing off). How it is kept safe is described in [SECURITY.md](SECURITY.md).

| You want | Use | Where |
| --- | --- | --- |
| A school, club or family calendar next to your reminders | Calendar subscription | Settings → Integrations |
| Expenses from a bank or credit-card statement you downloaded | Statement import | Expenses → Import from bank |
| Transactions from your bank without downloading anything | Bank connection (SimpleFIN) | Settings → Integrations |

## Calendars

Google Calendar, iCloud, Outlook, Nextcloud and most others can publish a calendar as an `.ics` address.
Paste it in **Settings → Integrations → Calendars**. HomeVault copies the events in on a schedule (hourly by
default) and shows them, marked as external, on the Calendar page. Repeating events, exceptions, all-day
events and time zones are handled; the window is about a month back to just over a year ahead.

- **Google**: Settings → choose the calendar → *Integrate calendar* → **Secret address in iCal format**.
- **iCloud**: share the calendar as a public calendar and copy its link.
- **Outlook**: Settings → Calendar → Shared calendars → *Publish a calendar* → copy the ICS link.

The address is a password: anyone who has it can read that calendar. HomeVault checks it, then keeps it
encrypted and never shows it again. To subscribe to a calendar on your own network (for example Nextcloud at
`192.168.x.x`), set `INTEGRATIONS_ALLOW_PRIVATE_HOSTS=true`.

## Importing a bank or credit-card statement

Download a statement from your bank's website (CSV is most common; OFX, QFX and QIF work too), then open
**Expenses → Import from bank**.

1. **Choose the file.** HomeVault shows what it understood *before* saving anything: how many transactions,
   the date range, money in and out, and how many are new. If it had to guess (for example `05/11/2026`
   could be 5 November or May 11), it says so and lets you pick the date order. If every amount is positive
   (typical for credit cards), tick *Purchases are positive numbers in this file*. If it cannot tell which
   column is which, you choose the columns.
2. **Add to the inbox.** New transactions wait in an inbox. **Nothing is an expense yet.**
3. **Review.** For each transaction pick a category (maintenance, insurance, tax, utility, improvement,
   other), optionally mark it home-office, and add the ones that belong to your home to Expenses. Skip the
   rest (groceries, coffee) and they stay out of the way. Refunds become negative expenses so totals stay right.
4. **Make rules.** *Rule…* turns "when the description contains HYDRO" into a suggested category (or "skip it")
   for every future import. Suggestions are never applied without your review.

Importing the same file twice, or two statements that overlap, adds nothing twice. A wrong import can be
undone while its transactions are still waiting. Statements are read in memory and not kept as files.

## Connecting a bank (SimpleFIN)

[SimpleFIN Bridge](https://www.simplefin.org/) is a separate, read-only service that a bank can be connected
to. Which banks it supports is up to the bridge, so check its list before relying on it. You sign up and connect
your bank there yourself; HomeVault never sees your bank login.

1. At your bridge, add a new connection for an app and copy the **setup token** it shows.
2. In **Settings → Integrations → Bank connection**, paste the token and press *Connect*. A token works only
   once. HomeVault trades it for a read-only access address and lists the accounts.
3. **Choose which accounts HomeVault may read.** Nothing is read until you do (you may want the joint account
   and the card, not a personal one). Saving reads them immediately.
4. New transactions arrive in the same inbox as an imported statement, on the schedule you chose (every 12
   hours by default; the bridge allows roughly 24 requests a day, so HomeVault will not go below every 2 hours).

Notes:

- Do not feed the *same account* both ways (a downloaded statement and the bank connection): the two have
  different transaction identities, so the same purchase could appear twice. Pick one per account.
- Pending transactions are ignored until they post. Each sync looks back about 89 days (the bridge's limit per
  request); if HomeVault was switched off for longer, older transactions would need a statement import.
- Removing the connection keeps what is already in the inbox. To cut access completely, also revoke the
  connection at your bridge.
- The bridge's own messages (for example "needs attention" for a bank that wants you to sign in again) are
  shown under the connection.
- Going through the bridge is only as trustworthy as the bridge. HomeVault keeps only the access address,
  encrypted, and it cannot move money.

## Turning it off or tightening it

| Setting | Effect |
| --- | --- |
| `INTEGRATIONS_ENABLED=false` | No outbound syncing at all; new connections are refused (statement import still works, it makes no network calls). |
| `INTEGRATIONS_ALLOW_PRIVATE_HOSTS=false` (default) | Addresses that point inside your network are refused. Also requires `https://` for bank connections. |
| Pause a connection | Keeps it, stops syncing until resumed. |
| Remove a connection | Deletes the stored address; events disappear, inbox transactions stay. |
