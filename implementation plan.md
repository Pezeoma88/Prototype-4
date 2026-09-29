# CarpoolBoard Implementation Plan

## Overview

CarpoolBoard is a campus-focused mobile carpool application. Students can sign in as a Driver or a Rider, offer rides, request rides, manage ride requests, and see who is participating in a ride. The goal is to make it easy for students to share rides to and from campus in a way that feels simple, safe, and trustworthy.

## Current State: Prototype 3 (in progress)

Prototype 3 has moved well past Prototype 2. The items below are grouped by how solid they are right now, so this plan stops describing finished work as if it were still missing.

### Already implemented and tested (verified on a real iPhone and in review)

- **Driver/Rider local account roles.** A simple sign-in screen creates or logs into a local account and assigns it the Driver or Rider role. There is no backend yet — accounts live only in the app's React state for the current session.
- **Shared/universal CarpoolBoard dashboard.** Both roles see the same Available Rides and Looking for a Ride sections; the signed-in role only changes which *actions* are available (offering vs. requesting), not what's visible on the board.
- **Offer a Ride** (name, destination, departure time, seat count), with validation on all fields.
- **Available Rides** list, shown as ride cards with destination, departure time, and seat status.
- **Riders Looking for a Ride** list, with self-removal for a rider who wants to stop looking.
- **Destination / departure time / seat count** captured and displayed for every ride.
- **Pending → Accept/Deny → Confirmed** request flow: a rider requests a specific ride, the request shows as Pending, and only the ride's own driver can Accept or Deny it. Seats only decrease when a request is **accepted**, never on request.
- **Confirmed passenger display** on each ride's details screen, including a rider's own "Leave" control to give up a confirmed seat (which reopens that seat).
- **Ride cancellation/rescinding.** The driver who posted a ride can cancel it from the ride's details screen, with a confirmation prompt before it's removed. Only that ride's driver can cancel it.
- **Full ride status.** A ride with 0 available seats shows a clear "Full" badge (on the ride card and in ride details) instead of just a seat count of 0, requesting a full ride is blocked, and the Full badge automatically clears again if a confirmed rider cancels their seat.
- **iOS seat-count keyboard fix.** The Offer a Ride form's numeric Seats field no longer traps the keyboard: it uses `keyboardType="number-pad"` with `returnKeyType="done"`, which shows iOS's own native Done control above the keyboard (confirmed working on a real iPhone — an earlier custom "Done" bar was removed once the native one was found to already work, to avoid showing two Done buttons). The whole form also sits inside a `KeyboardAvoidingView` + scrollable container so the Save button stays reachable.
- **Return to dashboard after saving a ride.** After a successful Save, the keyboard is dismissed, the form clears, and the view scrolls back up so the new ride is immediately visible in Available Rides. A submit guard prevents a fast double-tap from posting the same ride twice. Validation failures do not navigate away.

### Being developed in this session

- **Email-based local signup/login.** New accounts now require a name, an email address, and a role, with basic email format validation. The email is the account's identifier: returning users log back in with just their email and keep the name/role saved with that account. Still local-only React state — explicitly **not** secure production authentication (no password, no backend), structured so a real auth/persistence layer can replace it later without changing how the rest of the app reads the signed-in user.
- **Account/Profile view.** Reachable from a "Profile" link in the header, showing name, email, role, and a Log Out action, styled consistently with the rest of the app.
- **Rider request reason.** When requesting a specific ride, a rider can optionally add a short message (e.g. "Going to campus," "My car broke down"). The driver sees that reason next to the Pending request when deciding to Accept or Deny. Seats still only change on Accept, and the rest of the Pending → Accept/Deny → Confirmed flow is unchanged.

### Future semester development

- Real, persistent authentication (passwords or another real credential, a backend, or a managed auth service) to replace the local-only account prototype.
- Persistent storage for rides, requests, and accounts so data survives closing the app (likely device-local storage first, possibly a simple backend later).
- Real multi-user synchronization, so a ride posted on one device is visible live on another.
- Driver and Rider testing on separate physical devices at the same time, once real sync exists — today's local account switching (log out / log back in with a different role on one device) is a stand-in for this.
- Notifications or another asynchronous update mechanism (e.g. a driver is notified when a new request arrives, without needing to reopen the ride).
- Possible location/map functionality (e.g. showing pickup points or route context).
- Continued accessibility work (labels, contrast, touch targets), privacy review (what rider/driver info is shown to whom), broader failure handling, and further rounds of user testing.

## User Testing Feedback

### Earlier tester feedback (addressed)

- **Show who is actually participating in each ride.** ✅ Confirmed passengers are now shown on the ride details screen.
- **Allow rides to be canceled or deleted.** ✅ Drivers can cancel/rescind their own ride, with a confirmation prompt.
- **Change immediate rider matching into a request system.** ✅ Replaced with the Pending → Accept/Deny → Confirmed flow.
- **Optionally let riders add a reason or message with their request.** ✅ Implemented this session (see above).
- **Consider instructions/onboarding as the app becomes more complex.** Still open — no onboarding/instructions screen yet; revisit in Stage 6 below.

### Professor's user-testing feedback (addressed)

- **iOS form usability (seat-entry keyboard trap).** ✅ Fixed — see "iOS seat-count keyboard fix" above. Verified by testing on a real iPhone, including a follow-up fix after the first attempt (a custom InputAccessoryView) turned out not to render on-device; the current fix relies on iOS's own native Done control instead.
- **Clearly rescinding an offered ride.** ✅ The Cancel Ride action is on the ride's own details screen, visible only to that ride's driver, with a confirmation prompt before it's removed.
- **Full ride status.** ✅ A ride at 0 seats now shows a "Full" badge instead of requiring users to infer it from a seat count, and it automatically clears if a seat reopens.
- **Testing with multiple people (Driver and Rider on separate devices).** Not yet possible — this needs real multi-user sync (see "Future semester development"). The Driver/Rider account-role system added this session is a deliberate step toward that: the app already separates "who is signed in and what role are they" from "what's on the shared board," which is the structure real multi-device sync will plug into.

These items continue to shape the plan below.

## Semester Implementation Plan

Stage status is tracked per stage now that some are complete.

### Stage 1: Ride request and approval flow — ✅ Done
Riders send requests, requests show as Pending, and only the ride's driver can Accept or Deny. This replaced the old immediate rider matching.

### Stage 2: Confirmed passenger lists — ✅ Done
Confirmed passengers are shown on each ride's details screen. Seat counts update only when a request is accepted.

### Stage 3: Cancel/delete ride functionality — ✅ Done
Drivers can cancel/rescind their own rides, with a confirmation prompt. Riders can cancel a confirmed seat (which reopens it) or remove themselves from the waiting list (which also withdraws any pending requests they'd sent).

### Stage 4: Optional rider request messages — ✅ Done (this session)
Riders can add a short optional reason when requesting a ride; the driver sees it before deciding.

### Stage 4.5: Local account/role system and Profile — ✅ Done (this session)
Email-based local sign-in with Driver/Rider roles and a Profile view. Not yet real authentication — see Stage 5.

### Stage 5: Persistence and real authentication
Save rides, requests, and accounts so they're not lost when the app closes, and replace the local-only account prototype with real authentication. This will involve asynchronous storage, first on the device and possibly a simple backend later if scope allows.

### Stage 6: Accessibility and clearer instructions
Add readable labels, sufficient color contrast, and comfortable touch targets. Add short onboarding or in-app instructions to explain how requesting and approving works.

### Stage 7: Failure handling and privacy considerations
Handle problems such as failed saves, empty states, and duplicate requests, with clear messages (full rides are already handled — see above). Consider what personal information (names, emails, reasons/messages) is shown to whom, and share only what is needed.

### Stage 8: Real multi-user synchronization and cross-device testing
Move from local-only state to a real synced store so a ride posted by a Driver on one device is visible to a Rider on another device in real time. Test with one person as Driver and another as Rider on separate devices.

### Stage 9: Continued user testing, revision, and deployment
Run more rounds of user testing (including the cross-device testing from Stage 8), revise based on feedback, and prepare a deployable build that others can install and try. Finish documentation.

## Course Learning Outcomes

| Concept | How it connects to this plan |
| --- | --- |
| Iterative prototyping | Prototype 2 → Prototype 3 spike → role system, cancellation, Full status, and iOS fixes → email accounts, Profile, and request reasons (this session), each revised after a round of feedback |
| AI-assisted development | AI tools helped draft code and ideas throughout the project |
| Understanding and modifying AI-generated code | I read, tested (including on a real iPhone), and adjusted the AI-generated code across sessions — for example, catching that the first iOS keyboard fix didn't actually work on-device and directing a second fix |
| State and event flow | The account/role system, and Stages 1–4 center on how request status, passengers, seats, and the signed-in user change in response to user actions |
| Persistence | Stage 5 saves rides, requests, and accounts between sessions and replaces the local-only account prototype with real authentication |
| Asynchronous behavior | Saving and loading data (Stage 5) and real-time sync (Stage 8) happen asynchronously and must be handled in the UI |
| Accessibility | Stage 6 covers labels, contrast, touch targets, and instructions |
| Testing | Manual test cases for each flow (request, accept, deny, cancel, full ride, sign-in/sign-out, Profile), including real-device iOS testing, plus more user testing in Stage 9 |
| Privacy | Stage 7 considers what rider and driver information (including email and request reasons) is shared and with whom |
| Failure handling | Stage 7 covers failed saves and duplicate or invalid actions; full-ride handling and account/email validation are already in place |
| Version control/documentation | Regular commits with clear messages, and this plan updated as decisions are made and features land |
| Mobile affordances | Touch-friendly buttons, clear status indicators (including "Full"), and layouts designed for phone screens, with iOS keyboard behavior specifically tested and fixed |
| Deployment | Stage 9 prepares a build that testers can install |
| User testing | Both earlier tester feedback and the professor's iOS/cancellation/Full-status/multi-user feedback have already shaped this plan, and more rounds are planned in Stage 9 |
| Feasibility/scope | Work is ordered so the most valuable features (request/approval, cancellation, Full status, iOS usability) came first; real backend/sync work is scoped for later and can flex if time is tight |
| Producing a substantial functioning project | The end goal is a working, tested, documented carpool app built from the staged plan; Prototype 3 already has a functioning Driver/Rider flow end to end |
