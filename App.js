import { useCallback, useEffect, useRef, useState } from 'react';
import { StatusBar } from 'expo-status-bar';
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { supabase } from './lib/supabase';

// Basic email shape check (not full RFC 5322 validation): local part, "@",
// domain, a dot, and a TLD, no spaces. Enough to reject obviously invalid
// addresses without a validation library.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Seat limits for an offered ride. A typical car can carry at most 7
// passengers besides the driver, so anything outside 1–7 is rejected.
const MIN_SEATS = 1;
const MAX_SEATS = 7;

// Sort options for Available Rides. Departure Time works now that departure
// is stored as a real timestamp (rides.departure_at) instead of free text.
const RIDE_SORT_OPTIONS = [
  { key: 'default', label: 'Default' },
  { key: 'destination', label: 'Destination' },
  { key: 'departure', label: 'Departure Time' },
];

// Minute steps shown in the departure time wheel.
const DEPARTURE_MINUTE_INTERVAL = 5;

// Formats a departure Date for display, e.g. "Tue, Sep 30 · 5:30 PM". The
// year is only added when it isn't the current year.
function formatDeparture(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    return 'Unknown time';
  }
  const dateOptions = { weekday: 'short', month: 'short', day: 'numeric' };
  if (date.getFullYear() !== new Date().getFullYear()) {
    dateOptions.year = 'numeric';
  }
  const datePart = date.toLocaleDateString('en-US', dateOptions);
  const timePart = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${datePart} · ${timePart}`;
}

// A sensible starting value for the departure wheels: the next
// DEPARTURE_MINUTE_INTERVAL step at least 15 minutes from now.
function getDefaultDeparture() {
  const step = DEPARTURE_MINUTE_INTERVAL * 60 * 1000;
  return new Date(Math.ceil((Date.now() + 15 * 60 * 1000) / step) * step);
}

// The profiles table stores emails lowercase (profiles_email_check), so every
// email sent to Supabase goes through this first. "  David@Email.com " and
// "david@email.com" are the same account.
function normalizeEmail(email) {
  return email.trim().toLowerCase();
}

// Converts a `profiles` row into the account shape the app already uses.
function profileToAccount(row) {
  return { id: row.id, name: row.name, email: row.email, role: row.role };
}

// Turns Supabase rows into the `drivers` state shape the UI already renders.
// Available seats are always derived as seat_count - accepted requests.
function buildDriversFromRows(rideRows, requestRows, profilesById) {
  return rideRows.map((ride) => {
    const requests = requestRows.filter((req) => req.ride_id === ride.id);
    const matchedRiders = requests
      .filter((req) => req.status === 'accepted')
      .map((req) => ({
        id: req.rider_id,
        requestId: req.id,
        name: profilesById[req.rider_id]?.name || 'Unknown rider',
      }));
    const pendingRequests = requests
      .filter((req) => req.status === 'pending')
      .map((req) => ({
        id: req.id,
        riderId: req.rider_id,
        name: profilesById[req.rider_id]?.name || 'Unknown rider',
        reason: req.reason || '',
      }));
    const departureAt = new Date(ride.departure_at);
    return {
      id: ride.id,
      driverAccountId: ride.driver_id,
      name: profilesById[ride.driver_id]?.name || 'Unknown driver',
      destination: ride.destination,
      departureAt,
      departureTime: formatDeparture(departureAt),
      totalSeats: ride.seat_count,
      seats: Math.max(0, ride.seat_count - matchedRiders.length),
      matchedRiders,
      pendingRequests,
    };
  });
}

// This is the home screen for CarpoolBoard.
// Drivers can be added (with a name and seat count), riders can ask for a ride,
// and a waiting rider can be matched to a driver's open seat.
//
// Prototype 4: the board is persisted in Supabase. `profiles` holds accounts,
// `rides` holds posted rides, and `ride_requests` holds each rider's request
// (pending / accepted / denied / cancelled). The app reloads the whole board
// from Supabase on launch, on pull-to-refresh, and after every change, then
// rebuilds the same `drivers` / `riders` shapes the UI rendered before.
export default function App() {
  // The list of drivers (posted rides), rebuilt from Supabase on every load.
  // Each driver is an object like
  // { id, driverAccountId, name, destination, departureAt, departureTime,
  //   totalSeats, seats, matchedRiders, pendingRequests }.
  // id is the ride's Supabase UUID; departureAt is a Date and departureTime
  // its display string. seats is the number of AVAILABLE seats
  // (totalSeats - accepted requests), so it only goes down on Accept.
  // matchedRiders collects { id, requestId, name } for every confirmed passenger on this ride.
  // pendingRequests collects { id, riderId, name, reason } for requests the driver hasn't answered yet.
  const [drivers, setDrivers] = useState([]);

  // True until the first Supabase load finishes, so the empty state isn't
  // shown before we actually know the board is empty.
  const [isBoardLoading, setIsBoardLoading] = useState(true);
  // True while a pull-to-refresh reload is running.
  const [isRefreshing, setIsRefreshing] = useState(false);
  // The last load error, if any. Already-loaded rides stay on screen.
  const [boardError, setBoardError] = useState('');

  // The signed-in account: { id, name, email, role }, or null when signed
  // out. id is the profile's stable Supabase UUID. This is a prototype, NOT
  // secure production authentication — there's no password and no Supabase
  // Auth. The email is the account's identifier (case-insensitive): "signing
  // up" creates a `profiles` row with a name + email + role, and "logging in"
  // again with the same email restores that same profile and its role.
  const [currentUser, setCurrentUser] = useState(null);

  // True while a Continue press is talking to Supabase.
  const [isSigningIn, setIsSigningIn] = useState(false);

  // The existing profile matching the email typed on the sign-in screen (or
  // null), looked up in Supabase shortly after the user stops typing.
  const [matchingAuthAccount, setMatchingAuthAccount] = useState(null);

  // The current text typed into the sign-in form, and the role toggle. Name
  // and role are only used when the email doesn't match an existing account.
  const [authNameInput, setAuthNameInput] = useState('');
  const [authEmailInput, setAuthEmailInput] = useState('');
  const [authRole, setAuthRole] = useState('driver');
  const [authError, setAuthError] = useState('');

  // Spike: a short message about the last request action (or why one was blocked).
  const [requestNotice, setRequestNotice] = useState('');

  // Whether the "Add Driver" form is currently showing.
  const [isAddingDriver, setIsAddingDriver] = useState(false);

  // The id of the ride being edited in the Post Ride form, or null when the
  // form is posting a new ride.
  const [editingRideId, setEditingRideId] = useState(null);

  // The current text typed into the form's inputs. The driver's name isn't
  // one of them: it comes from the signed-in account when the ride is posted.
  const [destinationInput, setDestinationInput] = useState('');
  const [seatsInput, setSeatsInput] = useState('');

  // The departure picked on the date/time wheels (a Date), or null until the
  // driver picks one. Saved to Supabase as rides.departure_at.
  const [departureAtInput, setDepartureAtInput] = useState(null);
  // When editing, the ride's original departure, so an unchanged (possibly
  // already-past) departure doesn't block saving other edits.
  const [originalDepartureAt, setOriginalDepartureAt] = useState(null);
  // Which wheel is open: 'date', 'time', or null when neither is showing.
  const [departurePickerMode, setDeparturePickerMode] = useState(null);

  // A validation message to show under the form, if something is wrong.
  const [formError, setFormError] = useState('');

  // How Available Rides is ordered: 'default' (posting order) or 'destination'.
  const [rideSortOrder, setRideSortOrder] = useState('default');

  // True while a Post Ride press is being handled, so a fast double-tap
  // can't post the same ride twice before the form has a chance to close.
  const [isSubmittingDriver, setIsSubmittingDriver] = useState(false);

  // Lets us scroll back to the top (Available Rides) after saving a ride.
  const scrollViewRef = useRef(null);

  // Riders who joined Looking for a Ride on this device without sending a
  // request yet: { id, name }. There's no Supabase table for the waiting
  // list itself, so these entries last only for this app session. Riders
  // with a pending request are rebuilt from Supabase instead (see `riders`).
  const [localWaitingRiders, setLocalWaitingRiders] = useState([]);

  // Every request row with status pending/accepted, from the last load. Used
  // to rebuild Looking for a Ride.
  const [activeRequestRows, setActiveRequestRows] = useState([]);
  // Profiles referenced by the loaded rides/requests, keyed by id.
  const [profilesById, setProfilesById] = useState({});

  // Guards against a fast double-tap firing the same Supabase change twice.
  const isBoardActionRunningRef = useRef(false);

  // Looking for a Ride, rebuilt as { id, name }: everyone with a pending
  // request in Supabase, plus anyone who joined on this device, minus anyone
  // who already has a confirmed (accepted) seat.
  const confirmedRiderIds = new Set(
    activeRequestRows.filter((req) => req.status === 'accepted').map((req) => req.rider_id)
  );
  const riders = [];
  for (const req of activeRequestRows) {
    if (req.status === 'pending' && !riders.some((r) => r.id === req.rider_id)) {
      riders.push({ id: req.rider_id, name: profilesById[req.rider_id]?.name || 'Unknown rider' });
    }
  }
  for (const rider of localWaitingRiders) {
    if (!riders.some((r) => r.id === rider.id)) {
      riders.push(rider);
    }
  }
  for (let i = riders.length - 1; i >= 0; i -= 1) {
    if (confirmedRiderIds.has(riders[i].id)) {
      riders.splice(i, 1);
    }
  }

  // Whether the "Request a Ride" panel is currently showing. The rider's
  // name comes from their signed-in account, so the panel has no inputs.
  const [isAddingRider, setIsAddingRider] = useState(false);

  // The id of the ride whose request-confirm panel is open, or null if none.
  const [reservingDriverId, setReservingDriverId] = useState(null);

  // The optional message a rider types to explain why they need a ride,
  // shown to the driver alongside their Pending request.
  const [requestReasonInput, setRequestReasonInput] = useState('');

  // Whether the signed-in user's Account/Profile screen is currently showing.
  const [isProfileOpen, setIsProfileOpen] = useState(false);

  // Details of the most recently confirmed match, or null when no confirmation is showing.
  // Shape: { riderName, driverName, destination, departureTime }.
  const [matchConfirmation, setMatchConfirmation] = useState(null);

  // The id of the driver whose Ride Details screen is currently open, or null if none.
  const [selectedRideDriverId, setSelectedRideDriverId] = useState(null);

  // Loads the whole board from Supabase: rides, their pending/accepted
  // requests, and the profiles those rows point at. On failure the rides
  // already on screen are kept and an error message is shown instead.
  const loadBoard = useCallback(async () => {
    try {
      const { data: rideRows, error: ridesError } = await supabase
        .from('rides')
        .select('id, driver_id, destination, departure_at, seat_count, created_at')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true });
      if (ridesError) throw ridesError;

      const { data: requestRows, error: requestsError } = await supabase
        .from('ride_requests')
        .select('id, ride_id, rider_id, reason, status, created_at')
        .in('status', ['pending', 'accepted'])
        .order('created_at', { ascending: true });
      if (requestsError) throw requestsError;

      const profileIds = [
        ...new Set([
          ...rideRows.map((ride) => ride.driver_id),
          ...requestRows.map((req) => req.rider_id),
        ]),
      ];
      let profileMap = {};
      if (profileIds.length > 0) {
        const { data: profileRows, error: profilesError } = await supabase
          .from('profiles')
          .select('id, name, email, role')
          .in('id', profileIds);
        if (profilesError) throw profilesError;
        profileMap = Object.fromEntries(profileRows.map((row) => [row.id, row]));
      }

      setProfilesById(profileMap);
      setActiveRequestRows(requestRows);
      setDrivers(buildDriversFromRows(rideRows, requestRows, profileMap));
      setBoardError('');
      return true;
    } catch (error) {
      console.warn('CarpoolBoard: failed to load board from Supabase', error);
      setBoardError("Couldn't load rides from the server. Pull down to try again.");
      return false;
    } finally {
      setIsBoardLoading(false);
    }
  }, []);

  // Restore the board from Supabase as soon as CarpoolBoard launches.
  useEffect(() => {
    loadBoard();
  }, [loadBoard]);

  // Pull-to-refresh: fetch the latest board without restarting the app.
  async function handleRefresh() {
    setIsRefreshing(true);
    await loadBoard();
    setIsRefreshing(false);
  }

  // Runs one Supabase change at a time (ignoring double-taps), then reloads
  // the board so the UI always reflects what's actually stored.
  async function runBoardAction(action) {
    if (isBoardActionRunningRef.current) {
      return;
    }
    isBoardActionRunningRef.current = true;
    try {
      await action();
    } finally {
      isBoardActionRunningRef.current = false;
      await loadBoard();
    }
  }

  // Looks up a profile by email (case-insensitive, via normalizeEmail).
  // Returns the account or null; throws on a network/database error.
  async function findProfileByEmail(email) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, name, email, role')
      .eq('email', normalizeEmail(email))
      .limit(1);
    if (error) throw error;
    return data.length > 0 ? profileToAccount(data[0]) : null;
  }

  // Live-matches the sign-in email field against existing profiles in
  // Supabase, so the form can show a "welcome back" notice and skip the
  // name/role fields before the user even presses Continue. The lookup waits
  // until typing pauses, and ignores results for an email that's since changed.
  const trimmedAuthEmail = normalizeEmail(authEmailInput);
  useEffect(() => {
    setMatchingAuthAccount(null);
    if (currentUser !== null || !EMAIL_PATTERN.test(trimmedAuthEmail)) {
      return undefined;
    }
    let isStale = false;
    const timer = setTimeout(() => {
      findProfileByEmail(trimmedAuthEmail)
        .then((account) => {
          if (!isStale) setMatchingAuthAccount(account);
        })
        .catch(() => {
          // Continue will retry the lookup and report any real error.
        });
    }, 400);
    return () => {
      isStale = true;
      clearTimeout(timer);
    };
  }, [trimmedAuthEmail, currentUser]);

  // Runs when the user presses "Continue" on the sign-in screen. An email
  // that matches an existing profile logs back into it (keeping the name and
  // role on file); a new email requires a name and role to create a new
  // profile in Supabase. Email (not name) is the account identifier.
  async function handleSignIn() {
    if (isSigningIn) {
      return;
    }
    const trimmedName = authNameInput.trim();
    // Normalized so lookup and insert both use the lowercase form Supabase
    // requires. The text field itself still shows what the user typed.
    const trimmedEmail = normalizeEmail(authEmailInput);

    if (trimmedEmail === '') {
      setAuthError('Please enter your email address.');
      return;
    }
    if (!EMAIL_PATTERN.test(trimmedEmail)) {
      setAuthError('Please enter a valid email address.');
      return;
    }

    setIsSigningIn(true);
    try {
      let account = await findProfileByEmail(trimmedEmail);

      if (!account) {
        if (trimmedName === '') {
          setAuthError('Please enter your name.');
          return;
        }
        const { data, error } = await supabase
          .from('profiles')
          .insert({ name: trimmedName, email: trimmedEmail, role: authRole })
          .select('id, name, email, role')
          .single();
        if (error) {
          // 23505 = unique violation: the email was registered in the
          // meantime (e.g. from another phone), so just log into that one.
          if (error.code === '23505') {
            account = await findProfileByEmail(trimmedEmail);
          }
          if (!account) throw error;
        } else {
          account = profileToAccount(data);
        }
      }

      setCurrentUser(account);
      setAuthNameInput('');
      setAuthEmailInput('');
      setAuthError('');
      loadBoard();
    } catch (error) {
      console.warn('CarpoolBoard: sign-in failed', error);
      setAuthError("Couldn't reach CarpoolBoard's server. Check your connection and try again.");
    } finally {
      setIsSigningIn(false);
    }
  }

  // Signs the current account out. The shared board (drivers/riders) is left
  // untouched so the next person to sign in still sees the same board.
  function handleSignOut() {
    setCurrentUser(null);
    resetForm();
    setIsAddingRider(false);
    setSelectedRideDriverId(null);
    setReservingDriverId(null);
    setRequestNotice('');
    setIsProfileOpen(false);
  }

  // Opens the signed-in user's Account/Profile screen, closing any open ride
  // details/matching first so the two screens can't overlap.
  function handleOpenProfile() {
    setSelectedRideDriverId(null);
    setReservingDriverId(null);
    setRequestNotice('');
    setIsProfileOpen(true);
  }

  // Closes the Account/Profile screen and returns to the dashboard.
  function handleCloseProfile() {
    setIsProfileOpen(false);
  }

  // Opens the Offer a Ride form.
  function handleAddDriver() {
    setIsAddingDriver(true);
  }

  // Opens the same Post Ride form pre-filled with one of the signed-in
  // driver's rides, so they can change its destination, departure, or seats.
  function handleStartEditRide(driverId) {
    const driver = drivers.find((d) => d.id === driverId);
    if (!driver || !currentUser || driver.driverAccountId !== currentUser.id) {
      return;
    }
    setEditingRideId(driver.id);
    setDestinationInput(driver.destination);
    setDepartureAtInput(driver.departureAt);
    setOriginalDepartureAt(driver.departureAt);
    setSeatsInput(String(driver.totalSeats));
    setDeparturePickerMode(null);
    setFormError('');
    setSelectedRideDriverId(null);
    setReservingDriverId(null);
    setRequestNotice('');
    setIsAddingDriver(true);
    // The form sits below Available Rides; bring it into view once rendered.
    setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: true }), 150);
  }

  // Closes the form and clears out anything the user typed.
  function resetForm() {
    setIsAddingDriver(false);
    setEditingRideId(null);
    setDestinationInput('');
    setDepartureAtInput(null);
    setOriginalDepartureAt(null);
    setDeparturePickerMode(null);
    setSeatsInput('');
    setFormError('');
    setIsSubmittingDriver(false);
  }

  // Shows (or hides, if it's already showing) the date or time wheel.
  // The first time a wheel opens, it starts from a near-future default.
  function handleToggleDeparturePicker(mode) {
    Keyboard.dismiss();
    if (departureAtInput === null) {
      setDepartureAtInput(getDefaultDeparture());
    }
    setDeparturePickerMode((current) => (current === mode ? null : mode));
  }

  // Called as the driver scrolls a wheel. The date wheel only changes the
  // day and the time wheel only changes the hour/minute, so the two picks
  // combine into one departure Date.
  function handleDeparturePicked(pickedDate) {
    if (!(pickedDate instanceof Date) || Number.isNaN(pickedDate.getTime())) {
      return;
    }
    const mode = departurePickerMode;
    setDepartureAtInput((current) => {
      const combined = new Date(current || getDefaultDeparture());
      if (mode === 'date') {
        combined.setFullYear(pickedDate.getFullYear(), pickedDate.getMonth(), pickedDate.getDate());
      } else {
        combined.setHours(pickedDate.getHours(), pickedDate.getMinutes(), 0, 0);
      }
      return combined;
    });
    // Android shows the picker as a one-shot dialog, so close it after a pick.
    if (Platform.OS !== 'ios') {
      setDeparturePickerMode(null);
    }
  }

  // Runs when the user presses "Post Ride" (or "Save Changes" when editing).
  // The ride is posted under the signed-in account's name, so the driver
  // never has to type it. The ride is written to Supabase, then the board
  // is reloaded from Supabase.
  async function handleSaveDriver() {
    // Guards against a fast double-tap posting the same ride twice.
    if (isSubmittingDriver || !currentUser) {
      return;
    }

    const trimmedDestination = destinationInput.trim();
    const seatsNumber = Number(seatsInput.trim());
    const editingDriver =
      editingRideId !== null ? drivers.find((d) => d.id === editingRideId) || null : null;
    const departureUnchanged =
      editingDriver !== null &&
      departureAtInput !== null &&
      originalDepartureAt !== null &&
      departureAtInput.getTime() === originalDepartureAt.getTime();

    // Validation: destination can't be empty, a departure must be picked and
    // be in the future, and seats must be a whole number from MIN_SEATS to
    // MAX_SEATS. When editing, an unchanged departure is allowed as-is.
    if (trimmedDestination === '') {
      setFormError('Please enter a destination.');
      return;
    }
    if (departureAtInput === null || Number.isNaN(departureAtInput.getTime())) {
      setFormError('Please choose a departure date and time.');
      return;
    }
    if (!departureUnchanged && departureAtInput.getTime() <= Date.now()) {
      setFormError('Departure must be in the future. Please pick a later date or time.');
      return;
    }
    if (
      seatsInput.trim() === '' ||
      !Number.isInteger(seatsNumber) ||
      seatsNumber < MIN_SEATS ||
      seatsNumber > MAX_SEATS
    ) {
      setFormError(`Seats must be between ${MIN_SEATS} and ${MAX_SEATS}.`);
      return;
    }
    if (editingRideId !== null && !editingDriver) {
      setFormError('This ride no longer exists. It may have been removed.');
      return;
    }

    setIsSubmittingDriver(true);
    setFormError('');

    try {
      if (editingDriver) {
        // Re-check confirmed riders against the server right before saving,
        // so total seats can't drop below who's already been accepted.
        const { count: acceptedCount, error: countError } = await supabase
          .from('ride_requests')
          .select('id', { count: 'exact', head: true })
          .eq('ride_id', editingDriver.id)
          .eq('status', 'accepted');
        if (countError) throw countError;
        if (seatsNumber < (acceptedCount ?? 0)) {
          setFormError(
            `This ride already has ${acceptedCount} confirmed rider${acceptedCount === 1 ? '' : 's'}, ` +
              `so it needs at least ${acceptedCount} seat${acceptedCount === 1 ? '' : 's'}.`
          );
          setIsSubmittingDriver(false);
          return;
        }

        const { data, error } = await supabase
          .from('rides')
          .update({
            destination: trimmedDestination,
            departure_at: departureAtInput.toISOString(),
            seat_count: seatsNumber,
          })
          .eq('id', editingDriver.id)
          .eq('driver_id', currentUser.id)
          .select('id');
        if (error) throw error;
        if (!data || data.length === 0) {
          throw new Error('No ride was updated.');
        }
      } else {
        const { error } = await supabase.from('rides').insert({
          driver_id: currentUser.id,
          destination: trimmedDestination,
          departure_at: departureAtInput.toISOString(),
          seat_count: seatsNumber,
        });
        if (error) throw error;
      }
    } catch (error) {
      console.warn('CarpoolBoard: saving ride failed', error);
      setFormError(
        editingDriver
          ? "Couldn't save your changes. Check your connection and try again."
          : "Couldn't post your ride. Check your connection and try again."
      );
      setIsSubmittingDriver(false);
      return;
    }

    // Success: dismiss the keyboard, close/reset the form, reload the board,
    // and scroll back up so the ride is visible in Available Rides right away.
    Keyboard.dismiss();
    resetForm();
    await loadBoard();
    scrollViewRef.current?.scrollTo({ y: 0, animated: true });
  }

  // Opens the Ride Details screen for a driver. This is the Available Rides -> Ride Details step.
  function handleViewRideDetails(driverId) {
    setSelectedRideDriverId(driverId);
    setRequestNotice('');
  }

  // Closes the Ride Details screen (and any in-progress matching) and returns to Available Rides.
  function handleBackToAvailableRides() {
    setSelectedRideDriverId(null);
    setReservingDriverId(null);
    setRequestNotice('');
  }

  // Cancels/rescinds an offered ride: removes it from Available Rides and
  // clears any Ride Details / Rider Matching state pointing at it. Other
  // drivers and riders are untouched. Only the driver who posted the ride
  // can rescind it, and we confirm first since this can't be undone.
  function handleCancelRide(driverId) {
    const driver = drivers.find((d) => d.id === driverId);
    if (!driver || !currentUser || driver.driverAccountId !== currentUser.id) {
      return;
    }

    Alert.alert(
      'Cancel this ride?',
      `This removes your ride to ${driver.destination} and can't be undone.`,
      [
        { text: 'Keep Ride', style: 'cancel' },
        {
          text: 'Cancel Ride',
          style: 'destructive',
          onPress: () =>
            runBoardAction(async () => {
              // Deleting the ride also removes its ride_requests through the
              // database's ON DELETE CASCADE relationship.
              const { data, error } = await supabase
                .from('rides')
                .delete()
                .eq('id', driverId)
                .eq('driver_id', currentUser.id)
                .select('id');
              if (error || !data || data.length === 0) {
                console.warn('CarpoolBoard: cancelling ride failed', error);
                setRequestNotice("Couldn't cancel this ride. Check your connection and try again.");
                return;
              }
              setSelectedRideDriverId(null);
              setReservingDriverId(null);
              setRequestNotice('');
            }),
        },
      ],
      { cancelable: true }
    );
  }

  // Opens (or closes, if already open) the request-confirm panel for a
  // driver, clearing any reason text left over from a different ride.
  function handleStartReserve(driverId) {
    setReservingDriverId((currentId) => (currentId === driverId ? null : driverId));
    setRequestReasonInput('');
  }

  // Closes the request-confirm panel without sending a request.
  function handleCancelReserve() {
    setReservingDriverId(null);
    setRequestReasonInput('');
  }

  // SPIKE, step 1: a waiting rider requests this specific ride, optionally
  // with a short reason so the driver has context when deciding. The request
  // is saved to ride_requests as Pending. Seats do NOT change yet, and the
  // rider stays in the waiting list (they could still request other rides).
  async function handleRequestRide(driverId, riderId, reason) {
    const driver = drivers.find((d) => d.id === driverId);
    const rider = currentUser && currentUser.id === riderId ? currentUser : null;
    if (!driver || !rider) {
      return;
    }

    // Nobody can request their own ride. The UI already hides the button for
    // this case; this is the backstop in case it's ever reached another way.
    if (driver.driverAccountId === riderId) {
      return;
    }

    if (driver.seats < 1) {
      setRequestNotice('This ride is full, so it is not accepting requests.');
      return;
    }
    if (driver.matchedRiders.some((r) => r.id === riderId)) {
      setRequestNotice(`${rider.name} is already a confirmed passenger on this ride.`);
      return;
    }
    if (driver.pendingRequests.some((req) => req.riderId === riderId)) {
      setRequestNotice(`${rider.name} already has a pending request for this ride.`);
      return;
    }

    const trimmedReason = reason ? reason.trim() : '';

    await runBoardAction(async () => {
      // A rider who was denied, or who gave up a seat, keeps an old row for
      // this ride. Re-requesting reopens that row as Pending instead of
      // adding a second one.
      const { data: existingRows, error: lookupError } = await supabase
        .from('ride_requests')
        .select('id, status')
        .eq('ride_id', driverId)
        .eq('rider_id', rider.id);
      if (lookupError) {
        console.warn('CarpoolBoard: request lookup failed', lookupError);
        setRequestNotice("Couldn't send your request. Check your connection and try again.");
        return;
      }
      if (existingRows.some((row) => row.status === 'accepted')) {
        setRequestNotice(`${rider.name} is already a confirmed passenger on this ride.`);
        return;
      }
      if (existingRows.some((row) => row.status === 'pending')) {
        setRequestNotice(`${rider.name} already has a pending request for this ride.`);
        return;
      }

      const { error } =
        existingRows.length > 0
          ? await supabase
              .from('ride_requests')
              .update({ status: 'pending', reason: trimmedReason || null })
              .eq('id', existingRows[0].id)
          : await supabase.from('ride_requests').insert({
              ride_id: driverId,
              rider_id: rider.id,
              reason: trimmedReason || null,
              status: 'pending',
            });
      if (error) {
        // P0001 = an error raised on purpose by the database (e.g. the
        // prevent_self_request trigger), whose message is meant for users.
        console.warn('CarpoolBoard: sending request failed', error);
        setRequestNotice(
          error.code === 'P0001' && error.message
            ? error.message
            : "Couldn't send your request. Check your connection and try again."
        );
        return;
      }

      setReservingDriverId(null);
      setRequestReasonInput('');
      setRequestNotice(`${rider.name}'s request is now Pending.`);
    });
  }

  // SPIKE, step 2a: the driver accepts a pending request.
  // The rider becomes a confirmed passenger, available seats go down by 1,
  // and the rider leaves the waiting list (their requests to other rides are
  // cancelled). The accept itself runs in the database's accept_ride_request
  // function, which is what prevents overbooking.
  async function handleAcceptRequest(driverId, requestId) {
    const driver = drivers.find((d) => d.id === driverId);
    const request = driver && driver.pendingRequests.find((req) => req.id === requestId);
    if (!driver || !request) {
      return;
    }

    // A driver can never accept themselves as a passenger on their own ride.
    if (request.riderId === driver.driverAccountId) {
      return;
    }

    // Edge case: the ride filled up while this request was waiting.
    if (driver.seats < 1) {
      setRequestNotice('This ride is full. Deny the request or free up a seat first.');
      return;
    }

    await runBoardAction(async () => {
      const { error } = await supabase.rpc('accept_ride_request', { p_request_id: requestId });
      if (error) {
        // P0001 = a rule enforced by accept_ride_request (e.g. the ride is
        // full, or the request is no longer pending); its message is for users.
        console.warn('CarpoolBoard: accepting request failed', error);
        setRequestNotice(
          error.code === 'P0001' && error.message
            ? error.message
            : "Couldn't accept this request. Check your connection and try again."
        );
        return;
      }

      // The rider has a seat now, so withdraw their other pending requests
      // and take them off Looking for a Ride.
      const { error: cleanupError } = await supabase
        .from('ride_requests')
        .update({ status: 'cancelled' })
        .eq('rider_id', request.riderId)
        .eq('status', 'pending');
      if (cleanupError) {
        console.warn("CarpoolBoard: cancelling rider's other requests failed", cleanupError);
      }
      setLocalWaitingRiders((current) => current.filter((r) => r.id !== request.riderId));
      setRequestNotice(`${request.name} accepted: now a confirmed passenger.`);
    });
  }

  // SPIKE, step 2b: the driver denies a pending request.
  // The request is marked denied; seats and confirmed passengers are unchanged.
  async function handleDenyRequest(driverId, requestId) {
    const driver = drivers.find((d) => d.id === driverId);
    const request = driver && driver.pendingRequests.find((req) => req.id === requestId);
    if (!driver || !request) {
      return;
    }

    await runBoardAction(async () => {
      const { data, error } = await supabase
        .from('ride_requests')
        .update({ status: 'denied' })
        .eq('id', requestId)
        .eq('status', 'pending')
        .select('id');
      if (error || !data || data.length === 0) {
        console.warn('CarpoolBoard: denying request failed', error);
        setRequestNotice("Couldn't deny this request. It may have already changed. Pull down to refresh.");
        return;
      }
      setRequestNotice(`${request.name}'s request was denied. Seats unchanged.`);
    });
  }

  // A confirmed rider gives up their seat: the seat re-opens on the ride
  // (so a "Full" ride stops showing as Full), and they go back to Looking
  // for a Ride so they can find another one. Only the rider themselves can
  // cancel their own seat.
  function handleCancelConfirmedSeat(driverId, riderId) {
    const driver = drivers.find((d) => d.id === driverId);
    const rider = driver && driver.matchedRiders.find((r) => r.id === riderId);
    if (!driver || !rider || !currentUser || currentUser.id !== riderId) {
      return;
    }

    Alert.alert(
      'Cancel your seat?',
      `You'll give up your confirmed seat on ${driver.name}'s ride to ${driver.destination}.`,
      [
        { text: 'Keep My Seat', style: 'cancel' },
        {
          text: 'Cancel Seat',
          style: 'destructive',
          onPress: () =>
            runBoardAction(async () => {
              // Marking the accepted request cancelled frees the seat, since
              // available seats are always seat_count - accepted requests.
              const { data, error } = await supabase
                .from('ride_requests')
                .update({ status: 'cancelled' })
                .eq('id', rider.requestId)
                .eq('status', 'accepted')
                .select('id');
              if (error || !data || data.length === 0) {
                console.warn('CarpoolBoard: cancelling seat failed', error);
                setRequestNotice("Couldn't cancel your seat. Check your connection and try again.");
                return;
              }
              setLocalWaitingRiders((current) =>
                current.some((r) => r.id === riderId)
                  ? current
                  : [...current, { id: riderId, name: rider.name }]
              );
              setRequestNotice(`${rider.name} canceled their seat. A seat is now open.`);
            }),
        },
      ],
      { cancelable: true }
    );
  }

  // Dismisses the Match Confirmed screen and returns to the normal home view.
  function handleDismissMatchConfirmation() {
    setMatchConfirmation(null);
  }

  // Opens the Request a Ride panel.
  function handleNeedRide() {
    setIsAddingRider(true);
  }

  // Closes the Request a Ride panel.
  function resetRiderForm() {
    setIsAddingRider(false);
  }

  // Runs when the rider presses "Add Me to Looking for a Ride". They're
  // listed under their account name, so there's nothing to type.
  function handleSaveRider() {
    if (!currentUser) {
      return;
    }

    // Riders are tied to their account id, so re-saving (e.g. after already
    // joining) just closes the form instead of adding a duplicate entry.
    if (riders.some((rider) => rider.id === currentUser.id)) {
      resetRiderForm();
      return;
    }

    // Add the new rider to the list, keeping all the existing riders.
    const newRider = {
      id: currentUser.id,
      name: currentUser.name,
    };
    setLocalWaitingRiders((current) => [...current, newRider]);

    resetRiderForm();
  }

  // A waiting rider stops looking for a ride: they leave the waiting list,
  // and any pending requests they had out to drivers are withdrawn too.
  function handleLeaveWaitlist(riderId) {
    const rider = riders.find((r) => r.id === riderId);
    if (!rider || !currentUser || currentUser.id !== riderId) {
      return;
    }

    Alert.alert(
      'Stop looking for a ride?',
      'This also cancels any pending requests you have sent.',
      [
        { text: 'Stay on the List', style: 'cancel' },
        {
          text: 'Remove Me',
          style: 'destructive',
          onPress: () =>
            runBoardAction(async () => {
              const { error } = await supabase
                .from('ride_requests')
                .update({ status: 'cancelled' })
                .eq('rider_id', riderId)
                .eq('status', 'pending');
              if (error) {
                console.warn('CarpoolBoard: withdrawing requests failed', error);
                Alert.alert(
                  "Couldn't remove you",
                  'Your pending requests could not be cancelled. Check your connection and try again.'
                );
                return;
              }
              setLocalWaitingRiders((current) => current.filter((r) => r.id !== riderId));
            }),
        },
      ],
      { cancelable: true }
    );
  }

  // Gets a single uppercase letter to show inside an avatar circle.
  function getInitial(name) {
    return name.trim().charAt(0).toUpperCase();
  }

  const detailsDriver = drivers.find((driver) => driver.id === selectedRideDriverId) || null;
  // Only the driver who posted a ride can manage it (accept/deny, cancel).
  const isOwnerDriver =
    currentUser !== null &&
    currentUser.role === 'driver' &&
    detailsDriver !== null &&
    detailsDriver.driverAccountId === currentUser.id;
  // True when the open ride belongs to the signed-in account, whatever its
  // role. Used to hide any action that would let someone interact with
  // their own listing (e.g. requesting a seat on their own ride).
  const isOwnDetailsRide =
    currentUser !== null &&
    detailsDriver !== null &&
    detailsDriver.driverAccountId === currentUser.id;
  const isCurrentUserWaiting =
    currentUser !== null && riders.some((rider) => rider.id === currentUser.id);

  // Available Rides in the chosen order. Sorting a copy keeps `drivers`
  // itself in posting order, which is what "Default" shows. Departure Time
  // puts upcoming rides first (soonest at the front), then rides whose
  // departure has already passed, each group in chronological order.
  const nowMs = Date.now();
  let sortedDrivers = drivers;
  if (rideSortOrder === 'destination') {
    sortedDrivers = [...drivers].sort((a, b) =>
      a.destination.localeCompare(b.destination, undefined, { sensitivity: 'base' })
    );
  } else if (rideSortOrder === 'departure') {
    sortedDrivers = [...drivers].sort((a, b) => {
      const aTime = a.departureAt.getTime();
      const bTime = b.departureAt.getTime();
      const aPast = aTime < nowMs;
      const bPast = bTime < nowMs;
      if (aPast !== bPast) {
        return aPast ? 1 : -1;
      }
      return aTime - bTime;
    });
  }

  // The ride open in the form's Edit mode, if any.
  const editingDriver =
    editingRideId !== null ? drivers.find((driver) => driver.id === editingRideId) || null : null;

  // Past days can't be picked on the date wheel. On the time wheel, earlier
  // times are blocked only when the chosen day is today. No limit is set when
  // editing a ride whose saved departure already passed, so the wheels still
  // show its real value (saving a changed departure still requires a future time).
  const departurePickerMinimumDate = (() => {
    const now = new Date();
    let minimum;
    if (departurePickerMode === 'date') {
      minimum = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (
      departureAtInput !== null &&
      departureAtInput.toDateString() === now.toDateString()
    ) {
      minimum = now;
    }
    if (minimum && departureAtInput !== null && departureAtInput < minimum) {
      return undefined;
    }
    return minimum;
  })();

  const showActionsRow = currentUser
    ? currentUser.role === 'driver'
      ? !isAddingDriver
      : !isAddingRider
    : false;

  if (currentUser === null) {
    // Sign-in screen: accounts are `profiles` rows in Supabase (no passwords).
    // Email is the account identifier; picking a name + role only applies
    // the first time an email is used. The rest of the app just reads
    // currentUser.role to decide what to show.
    return (
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="light" />
        <KeyboardAvoidingView
          style={styles.authFlexWrap}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
            <ScrollView
              contentContainerStyle={styles.authScrollContent}
              keyboardShouldPersistTaps="handled"
            >
              <View style={styles.authHeader}>
                <View style={styles.logoMark}>
                  <Text style={styles.logoMarkText}>C</Text>
                </View>
                <Text style={styles.authTitle}>CarpoolBoard</Text>
                <Text style={styles.authSubtitle}>Sign in to see the shared ride board.</Text>
              </View>

              <View style={styles.authCard}>
                <Text style={styles.authLabel}>Email</Text>
                <TextInput
                  style={styles.input}
                  placeholder="e.g. jordan@example.edu"
                  placeholderTextColor="#9AA3B2"
                  value={authEmailInput}
                  onChangeText={setAuthEmailInput}
                  keyboardType="email-address"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={Keyboard.dismiss}
                />

                {matchingAuthAccount ? (
                  <View style={styles.authReturningNotice}>
                    <Text style={styles.authReturningNoticeText}>
                      Welcome back, {matchingAuthAccount.name}! You'll log back in as{' '}
                      {matchingAuthAccount.role === 'driver' ? 'a Driver' : 'a Rider'}.
                    </Text>
                  </View>
                ) : (
                  <>
                    <Text style={styles.authLabel}>Your name</Text>
                    <TextInput
                      style={styles.input}
                      placeholder="e.g. Jordan Smith"
                      placeholderTextColor="#9AA3B2"
                      value={authNameInput}
                      onChangeText={setAuthNameInput}
                      returnKeyType="done"
                      onSubmitEditing={Keyboard.dismiss}
                    />

                    <Text style={styles.authLabel}>I am a...</Text>
                    <View style={styles.roleToggleRow}>
                      <TouchableOpacity
                        style={[
                          styles.roleToggleButton,
                          authRole === 'driver' && styles.roleToggleButtonActiveDriver,
                        ]}
                        onPress={() => setAuthRole('driver')}
                        activeOpacity={0.85}
                      >
                        <Text
                          style={[
                            styles.roleToggleText,
                            authRole === 'driver' && styles.roleToggleTextActive,
                          ]}
                        >
                          Driver
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.roleToggleButton,
                          authRole === 'rider' && styles.roleToggleButtonActiveRider,
                        ]}
                        onPress={() => setAuthRole('rider')}
                        activeOpacity={0.85}
                      >
                        <Text
                          style={[
                            styles.roleToggleText,
                            authRole === 'rider' && styles.roleToggleTextActive,
                          ]}
                        >
                          Rider
                        </Text>
                      </TouchableOpacity>
                    </View>
                  </>
                )}

                <Text style={styles.authHint}>
                  New here? Enter your name and pick a role. Already signed up? Just enter the
                  same email — your name and role are saved with it.
                </Text>

                {authError !== '' && <Text style={styles.errorText}>{authError}</Text>}

                <TouchableOpacity
                  style={[styles.saveDriverButton, isSigningIn && styles.rideCardButtonDisabled]}
                  onPress={handleSignIn}
                  disabled={isSigningIn}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.buttonText, isSigningIn && styles.rideCardButtonTextDisabled]}>
                    {isSigningIn ? 'Signing in…' : 'Continue'}
                  </Text>
                </TouchableOpacity>

                <Text style={styles.authDisclaimer}>
                  This is a class-project prototype login: your name, email, and role are saved to
                  CarpoolBoard's shared database, with no password and no real security. Anyone
                  who enters your email can sign in as you. Don't use a real/sensitive password
                  anywhere here.
                </Text>
              </View>
            </ScrollView>
          </TouchableWithoutFeedback>
        </KeyboardAvoidingView>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="light" />

      {/* Dark navy header: text + shape based branding, no emoji */}
      <View style={styles.header}>
        <View style={styles.brandRow}>
          <View style={styles.logoMark}>
            <Text style={styles.logoMarkText}>C</Text>
          </View>
          <View style={styles.brandTextGroup}>
            <Text style={styles.brandTitle}>CarpoolBoard</Text>
            <Text style={styles.brandTagline}>Share the ride. Split the drive.</Text>
          </View>
        </View>

        <View style={styles.accountRow}>
          <Text style={styles.accountText} numberOfLines={1}>
            Signed in as <Text style={styles.accountTextStrong}>{currentUser.name}</Text>
          </Text>
          <View
            style={[
              styles.roleBadge,
              currentUser.role === 'driver' ? styles.roleBadgeDriver : styles.roleBadgeRider,
            ]}
          >
            <Text style={styles.roleBadgeText}>
              {currentUser.role === 'driver' ? 'Driver' : 'Rider'}
            </Text>
          </View>
          <TouchableOpacity
            onPress={handleOpenProfile}
            activeOpacity={0.7}
            style={styles.accountActionButton}
          >
            <Text style={styles.profileLinkText}>Profile</Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={handleSignOut}
            activeOpacity={0.7}
            style={styles.accountActionButton}
          >
            <Text style={styles.logOutText}>Log Out</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.statRow}>
          <View style={styles.statChip}>
            <Text style={styles.statChipNumber}>{drivers.length}</Text>
            <Text style={styles.statChipLabel}>Drivers</Text>
          </View>
          <View style={styles.statDivider} />
          <View style={styles.statChip}>
            <Text style={styles.statChipNumber}>{riders.length}</Text>
            <Text style={styles.statChipLabel}>Riders Waiting</Text>
          </View>
        </View>
      </View>

      <KeyboardAvoidingView
        style={styles.mainFlexWrap}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
      <TouchableWithoutFeedback onPress={Keyboard.dismiss}>
      <ScrollView
        ref={scrollViewRef}
        style={styles.scrollArea}
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={isRefreshing}
            onRefresh={handleRefresh}
            tintColor="#3B6EF5"
            colors={['#3B6EF5']}
          />
        }
      >
        {matchConfirmation ? (
          /* Match Confirmed screen: shown after a rider is matched to a driver */
          <View style={styles.confirmationWrap}>
            <View style={styles.confirmationCard}>
              <View style={styles.confirmationIconCircle}>
                <Text style={styles.confirmationIcon}>✓</Text>
              </View>

              <Text style={styles.confirmationTitle}>Ride Matched!</Text>
              <Text style={styles.confirmationSubtitle}>
                {matchConfirmation.riderName} has been matched with {matchConfirmation.driverName}
                &apos;s ride.
              </Text>

              <View style={styles.confirmationDetailsBox}>
                <View style={styles.confirmationDetailRow}>
                  <Text style={styles.confirmationDetailLabel}>Rider</Text>
                  <Text style={styles.confirmationDetailValue}>
                    {matchConfirmation.riderName}
                  </Text>
                </View>
                <View style={styles.confirmationDetailDivider} />
                <View style={styles.confirmationDetailRow}>
                  <Text style={styles.confirmationDetailLabel}>Driver</Text>
                  <Text style={styles.confirmationDetailValue}>
                    {matchConfirmation.driverName}
                  </Text>
                </View>
                <View style={styles.confirmationDetailDivider} />
                <View style={styles.confirmationDetailRow}>
                  <Text style={styles.confirmationDetailLabel}>Destination</Text>
                  <Text style={styles.confirmationDetailValue}>
                    {matchConfirmation.destination}
                  </Text>
                </View>
                <View style={styles.confirmationDetailDivider} />
                <View style={styles.confirmationDetailRow}>
                  <Text style={styles.confirmationDetailLabel}>Departs</Text>
                  <Text style={styles.confirmationDetailValue}>
                    {matchConfirmation.departureTime}
                  </Text>
                </View>
              </View>

              <TouchableOpacity
                style={[styles.saveDriverButton, styles.confirmationDoneButton]}
                onPress={handleDismissMatchConfirmation}
                activeOpacity={0.85}
              >
                <Text style={styles.buttonText}>Back to Rides</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : detailsDriver !== null ? (
          /* Ride Details screen: shown after selecting a ride from Available Rides */
          <View style={styles.detailsWrap}>
            <View style={styles.detailsCard}>
              <TouchableOpacity
                style={styles.detailsBackRow}
                onPress={handleBackToAvailableRides}
                activeOpacity={0.7}
              >
                <Text style={styles.detailsBackArrow}>‹</Text>
                <Text style={styles.detailsBackText}>Available Rides</Text>
              </TouchableOpacity>

              <View style={styles.detailsHeaderRow}>
                <View style={styles.avatarRing}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{getInitial(detailsDriver.name)}</Text>
                  </View>
                </View>
                <View style={styles.detailsHeaderText}>
                  <Text style={styles.detailsDriverName}>{detailsDriver.name}</Text>
                  <Text style={styles.detailsHeaderHint}>Ride Details</Text>
                </View>
              </View>

              <View style={styles.confirmationDetailsBox}>
                <View style={styles.confirmationDetailRow}>
                  <Text style={styles.confirmationDetailLabel}>Destination</Text>
                  <Text style={styles.confirmationDetailValue}>{detailsDriver.destination}</Text>
                </View>
                <View style={styles.confirmationDetailDivider} />
                <View style={styles.confirmationDetailRow}>
                  <Text style={styles.confirmationDetailLabel}>Departs</Text>
                  <Text style={styles.confirmationDetailValue}>{detailsDriver.departureTime}</Text>
                </View>
                <View style={styles.confirmationDetailDivider} />
                <View style={styles.confirmationDetailRow}>
                  <Text style={styles.confirmationDetailLabel}>Available Seats</Text>
                  {detailsDriver.seats === 0 ? (
                    <View style={styles.fullPill}>
                      <Text style={styles.fullPillText}>Full</Text>
                    </View>
                  ) : (
                    <Text style={styles.confirmationDetailValue}>{detailsDriver.seats}</Text>
                  )}
                </View>
              </View>

              {requestNotice !== '' && (
                <View style={styles.noticeBox}>
                  <Text style={styles.noticeText}>{requestNotice}</Text>
                </View>
              )}

              <View style={styles.sectionHeaderRow}>
                <View style={[styles.sectionAccent, styles.sectionAccentRider]} />
                <Text style={styles.sectionTitle}>
                  Pending requests ({detailsDriver.pendingRequests.length})
                </Text>
              </View>

              {detailsDriver.pendingRequests.length === 0 ? (
                <Text style={styles.detailsMatchedEmpty}>No pending requests.</Text>
              ) : (
                <View style={styles.pendingList}>
                  {detailsDriver.pendingRequests.map((request) => (
                    <View key={request.id} style={styles.pendingRow}>
                      <View style={[styles.avatar, styles.riderAvatar, styles.riderPickAvatar]}>
                        <Text style={styles.avatarText}>{getInitial(request.name)}</Text>
                      </View>
                      <View style={styles.pendingInfo}>
                        <Text style={styles.riderPickName}>{request.name}</Text>
                        <Text style={styles.pendingStatus}>Pending</Text>
                        {request.reason ? (
                          <Text style={styles.pendingReasonText} numberOfLines={2}>
                            “{request.reason}”
                          </Text>
                        ) : null}
                      </View>
                      {isOwnerDriver && (
                        <>
                          {/* Never offer "Accept" on a request from the
                              ride's own driver: they can't be their own
                              passenger. */}
                          {request.riderId !== detailsDriver.driverAccountId && (
                          <TouchableOpacity
                            style={[
                              styles.acceptButton,
                              detailsDriver.seats === 0 && styles.rideCardButtonDisabled,
                            ]}
                            onPress={() => handleAcceptRequest(detailsDriver.id, request.id)}
                            disabled={detailsDriver.seats === 0}
                            activeOpacity={0.85}
                          >
                            <Text
                              style={[
                                styles.acceptButtonText,
                                detailsDriver.seats === 0 && styles.rideCardButtonTextDisabled,
                              ]}
                            >
                              {detailsDriver.seats === 0 ? 'Full' : 'Accept'}
                            </Text>
                          </TouchableOpacity>
                          )}
                          <TouchableOpacity
                            style={styles.denyButton}
                            onPress={() => handleDenyRequest(detailsDriver.id, request.id)}
                            activeOpacity={0.85}
                          >
                            <Text style={styles.denyButtonText}>Deny</Text>
                          </TouchableOpacity>
                        </>
                      )}
                    </View>
                  ))}
                </View>
              )}

              <View style={styles.sectionHeaderRow}>
                <View style={[styles.sectionAccent, styles.sectionAccentDriver]} />
                <Text style={styles.sectionTitle}>
                  Confirmed passengers ({detailsDriver.matchedRiders.length})
                </Text>
              </View>

              {detailsDriver.matchedRiders.length === 0 ? (
                <Text style={styles.detailsMatchedEmpty}>No confirmed passengers yet.</Text>
              ) : (
                <View style={styles.riderChipRow}>
                  {detailsDriver.matchedRiders.map((rider) => {
                    const isSelf = currentUser.role === 'rider' && rider.id === currentUser.id;
                    return (
                      <View key={rider.id} style={styles.riderChip}>
                        <View style={[styles.avatar, styles.riderChipAvatar]}>
                          <Text style={styles.avatarText}>{getInitial(rider.name)}</Text>
                        </View>
                        <Text style={styles.riderChipName}>{rider.name}</Text>
                        {isSelf && (
                          <TouchableOpacity
                            style={styles.riderChipLeaveButton}
                            onPress={() => handleCancelConfirmedSeat(detailsDriver.id, rider.id)}
                            activeOpacity={0.7}
                          >
                            <Text style={styles.riderChipLeaveText}>Leave</Text>
                          </TouchableOpacity>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}

              {/* Requesting is hidden entirely on your own ride, so nobody can
                  request a seat from themselves. */}
              {currentUser.role === 'rider' &&
                !isOwnDetailsRide &&
                (reservingDriverId === detailsDriver.id ? (
                  /* Rider Matching: the signed-in rider confirms their own request. */
                  <View style={styles.reservationPanel}>
                    <Text style={styles.reservationTitle}>
                      Request {detailsDriver.name}&apos;s ride
                    </Text>
                    <Text style={styles.reservationSubtitle}>
                      Send this request as {currentUser.name}. The driver will accept or deny it.
                    </Text>

                    <TextInput
                      style={[styles.input, styles.reasonInput]}
                      placeholder='Optional: why do you need this ride? (e.g. "Going to campus")'
                      placeholderTextColor="#9AA3B2"
                      value={requestReasonInput}
                      onChangeText={setRequestReasonInput}
                      multiline
                      numberOfLines={2}
                      maxLength={140}
                      returnKeyType="done"
                      blurOnSubmit
                      onSubmitEditing={Keyboard.dismiss}
                    />

                    <TouchableOpacity
                      style={styles.saveRiderButton}
                      onPress={() => handleRequestRide(detailsDriver.id, currentUser.id, requestReasonInput)}
                      activeOpacity={0.85}
                    >
                      <Text style={styles.buttonText}>Confirm Request</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                      style={styles.cancelButton}
                      onPress={handleCancelReserve}
                      activeOpacity={0.85}
                    >
                      <Text style={styles.cancelButtonText}>Cancel</Text>
                    </TouchableOpacity>
                  </View>
                ) : (
                  (() => {
                    const alreadyConfirmed = detailsDriver.matchedRiders.some(
                      (r) => r.id === currentUser.id
                    );
                    const alreadyPending = detailsDriver.pendingRequests.some(
                      (req) => req.riderId === currentUser.id
                    );

                    let reserveLabel = 'Request This Ride';
                    if (detailsDriver.seats === 0) {
                      reserveLabel = 'Full';
                    } else if (alreadyConfirmed) {
                      reserveLabel = 'Already Confirmed';
                    } else if (alreadyPending) {
                      reserveLabel = 'Request Pending';
                    }
                    const reserveDisabled =
                      detailsDriver.seats === 0 || alreadyConfirmed || alreadyPending;

                    return (
                      <TouchableOpacity
                        style={[
                          styles.saveDriverButton,
                          reserveDisabled && styles.rideCardButtonDisabled,
                        ]}
                        onPress={() => {
                          // Joins the shared waiting list automatically the first
                          // time a rider requests a ride, using their own account.
                          setLocalWaitingRiders((current) =>
                            current.some((r) => r.id === currentUser.id)
                              ? current
                              : [...current, { id: currentUser.id, name: currentUser.name }]
                          );
                          handleStartReserve(detailsDriver.id);
                        }}
                        disabled={reserveDisabled}
                        activeOpacity={0.85}
                      >
                        <Text
                          style={[
                            styles.buttonText,
                            reserveDisabled && styles.rideCardButtonTextDisabled,
                          ]}
                        >
                          {reserveLabel}
                        </Text>
                      </TouchableOpacity>
                    );
                  })()
                ))}

              {isOwnerDriver && (
                <TouchableOpacity
                  style={styles.editRideButton}
                  onPress={() => handleStartEditRide(detailsDriver.id)}
                  activeOpacity={0.85}
                >
                  <Text style={styles.editRideButtonText}>Edit Ride</Text>
                </TouchableOpacity>
              )}

              {isOwnerDriver && (
                <TouchableOpacity
                  style={styles.cancelRideButton}
                  onPress={() => handleCancelRide(detailsDriver.id)}
                  activeOpacity={0.85}
                >
                  <Text style={styles.cancelRideButtonText}>Cancel Ride</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>
        ) : isProfileOpen ? (
          /* Account/Profile screen: name, email, role, and log out. */
          <View style={styles.detailsWrap}>
            <View style={styles.detailsCard}>
              <TouchableOpacity
                style={styles.detailsBackRow}
                onPress={handleCloseProfile}
                activeOpacity={0.7}
              >
                <Text style={styles.detailsBackArrow}>‹</Text>
                <Text style={styles.detailsBackText}>Available Rides</Text>
              </TouchableOpacity>

              <View style={styles.detailsHeaderRow}>
                <View style={styles.avatarRing}>
                  <View style={styles.avatar}>
                    <Text style={styles.avatarText}>{getInitial(currentUser.name)}</Text>
                  </View>
                </View>
                <View style={styles.detailsHeaderText}>
                  <Text style={styles.detailsDriverName}>{currentUser.name}</Text>
                  <Text style={styles.detailsHeaderHint}>Account</Text>
                </View>
              </View>

              <View style={styles.confirmationDetailsBox}>
                <View style={styles.confirmationDetailRow}>
                  <Text style={styles.confirmationDetailLabel}>Name</Text>
                  <Text style={styles.confirmationDetailValue}>{currentUser.name}</Text>
                </View>
                <View style={styles.confirmationDetailDivider} />
                <View style={styles.confirmationDetailRow}>
                  <Text style={styles.confirmationDetailLabel}>Email</Text>
                  <Text style={styles.confirmationDetailValue}>{currentUser.email}</Text>
                </View>
                <View style={styles.confirmationDetailDivider} />
                <View style={styles.confirmationDetailRow}>
                  <Text style={styles.confirmationDetailLabel}>Role</Text>
                  <View
                    style={[
                      styles.roleBadge,
                      currentUser.role === 'driver'
                        ? styles.roleBadgeInlineDriver
                        : styles.roleBadgeInlineRider,
                    ]}
                  >
                    <Text style={styles.roleBadgeText}>
                      {currentUser.role === 'driver' ? 'Driver' : 'Rider'}
                    </Text>
                  </View>
                </View>
              </View>

              <Text style={styles.authDisclaimer}>
                This account is a class-project prototype: it's saved in CarpoolBoard's shared
                database, with no password or real authentication yet.
              </Text>

              <TouchableOpacity
                style={styles.cancelRideButton}
                onPress={handleSignOut}
                activeOpacity={0.85}
              >
                <Text style={styles.cancelRideButtonText}>Log Out</Text>
              </TouchableOpacity>
            </View>
          </View>
        ) : (
        <>
        {/* Available Rides section (drivers) */}
        <View style={styles.sectionHeaderRow}>
          <View style={[styles.sectionAccent, styles.sectionAccentDriver]} />
          <Text style={styles.sectionTitle}>Available Rides</Text>
        </View>

        {/* Sort control: only useful once there's more than one ride. */}
        {drivers.length > 1 && (
          <View style={styles.sortRow}>
            <Text style={styles.sortLabel}>Sort by</Text>
            {RIDE_SORT_OPTIONS.map((option) => {
              const isActive = rideSortOrder === option.key;
              return (
                <TouchableOpacity
                  key={option.key}
                  style={[styles.sortOption, isActive && styles.sortOptionActive]}
                  onPress={() => setRideSortOrder(option.key)}
                  activeOpacity={0.85}
                >
                  <Text style={[styles.sortOptionText, isActive && styles.sortOptionTextActive]}>
                    {option.label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* A failed load keeps any rides already shown; this just explains why
            they may be out of date. */}
        {boardError !== '' && (
          <View style={styles.noticeBox}>
            <Text style={styles.noticeText}>{boardError}</Text>
          </View>
        )}

        {drivers.length === 0 && isBoardLoading ? (
          <View style={styles.emptyCard}>
            <ActivityIndicator color="#3B6EF5" />
            <Text style={[styles.emptyMessage, styles.loadingMessage]}>Loading rides…</Text>
          </View>
        ) : drivers.length === 0 && boardError !== '' ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyMessage}>Rides couldn't be loaded.</Text>
          </View>
        ) : drivers.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyMessage}>No rides posted yet.</Text>
          </View>
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.rideCarousel}
          >
            {sortedDrivers.map((driver) => (
              <TouchableOpacity
                key={driver.id}
                style={styles.rideCard}
                onPress={() => handleViewRideDetails(driver.id)}
                activeOpacity={0.85}
              >
                <View style={styles.rideCardTop}>
                  <View style={styles.avatarRing}>
                    <View style={styles.avatar}>
                      <Text style={styles.avatarText}>{getInitial(driver.name)}</Text>
                    </View>
                  </View>
                  <View style={[styles.seatBadge, driver.seats === 0 && styles.seatBadgeFull]}>
                    <Text style={[styles.seatBadgeText, driver.seats === 0 && styles.seatBadgeTextFull]}>
                      {driver.seats === 0 ? 'Full' : `${driver.seats} seat${driver.seats === 1 ? '' : 's'}`}
                    </Text>
                  </View>
                </View>

                {driver.driverAccountId === currentUser.id && (
                  <Text style={styles.yourRideTag}>Your Ride</Text>
                )}
                <Text style={styles.rideCardName}>{driver.name}</Text>

                <View style={styles.rideCardRouteRow}>
                  <Text style={styles.rideCardRouteIcon}>→</Text>
                  <Text style={styles.rideCardDestination} numberOfLines={1}>
                    {driver.destination}
                  </Text>
                </View>

                <View style={styles.rideCardTimeBadge}>
                  <Text style={styles.rideCardTimeText}>Departs {driver.departureTime}</Text>
                </View>

                <Text style={styles.rideCardCounts}>
                  {driver.pendingRequests.length} pending · {driver.matchedRiders.length} confirmed
                </Text>

                <View style={styles.rideCardButton}>
                  <Text style={styles.rideCardButtonText}>View Details</Text>
                </View>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        {/* Looking for a Ride section (riders) */}
        <View style={styles.sectionHeaderRow}>
          <View style={[styles.sectionAccent, styles.sectionAccentRider]} />
          <Text style={styles.sectionTitle}>Looking for a Ride</Text>
        </View>

        {riders.length === 0 ? (
          <View style={styles.emptyCard}>
            <Text style={styles.emptyMessage}>No riders waiting.</Text>
          </View>
        ) : (
          <View style={styles.riderChipRow}>
            {riders.map((rider) => {
              const isSelf = currentUser.role === 'rider' && rider.id === currentUser.id;
              return (
                <View key={rider.id} style={styles.riderChip}>
                  <View style={[styles.avatar, styles.riderAvatar, styles.riderChipAvatar]}>
                    <Text style={styles.avatarText}>{getInitial(rider.name)}</Text>
                  </View>
                  <Text style={styles.riderChipName}>{rider.name}</Text>
                  {isSelf && (
                    <TouchableOpacity
                      style={styles.riderChipLeaveButton}
                      onPress={() => handleLeaveWaitlist(rider.id)}
                      activeOpacity={0.7}
                    >
                      <Text style={styles.riderChipLeaveText}>Remove</Text>
                    </TouchableOpacity>
                  )}
                </View>
              );
            })}
          </View>
        )}

        {/* Primary actions: side-by-side quick-action cards */}
        {showActionsRow && (
          <View style={styles.actionsRow}>
            {currentUser.role === 'driver' && !isAddingDriver && (
              <TouchableOpacity
                style={[styles.actionCard, styles.actionCardDriver]}
                onPress={handleAddDriver}
                activeOpacity={0.85}
              >
                <Text style={styles.actionCardLabel}>Offer a Ride</Text>
                <Text style={styles.actionCardHint}>Have extra seats?</Text>
              </TouchableOpacity>
            )}
            {currentUser.role === 'rider' && !isAddingRider && (
              <TouchableOpacity
                style={[styles.actionCard, styles.actionCardRider]}
                onPress={handleNeedRide}
                activeOpacity={0.85}
              >
                <Text style={styles.actionCardLabel}>Request a Ride</Text>
                <Text style={styles.actionCardHint}>
                  {isCurrentUserWaiting ? "You're on the list" : 'Need a lift?'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Add Driver form */}
        {currentUser.role === 'driver' && isAddingDriver && (
          <View style={styles.section}>
            <View style={styles.sectionHeaderRow}>
              <View style={[styles.sectionAccent, styles.sectionAccentDriver]} />
              <Text style={styles.sectionTitle}>
                {editingRideId !== null ? 'Edit Ride' : 'Offer a Ride'}
              </Text>
            </View>

            <Text style={styles.formHint}>
              {editingRideId !== null ? 'Editing as ' : 'Posting as '}
              <Text style={styles.formHintStrong}>{currentUser.name}</Text>
            </Text>

            <Text style={styles.authLabel}>Where are you going?</Text>
            <TextInput
              style={styles.input}
              placeholder="Destination (e.g. Campus Library)"
              placeholderTextColor="#9AA3B2"
              value={destinationInput}
              onChangeText={setDestinationInput}
              onFocus={() => setDeparturePickerMode(null)}
              returnKeyType="done"
              onSubmitEditing={Keyboard.dismiss}
            />

            {/* Departure is picked on native scrolling wheels instead of typed:
                one wheel for the day and one for the time, combined into a
                single Date. On iPhone the wheels appear inline (spinner
                style); on Android the system date/time dialogs are used. */}
            <Text style={styles.authLabel}>When are you leaving?</Text>
            <View style={[styles.input, styles.departureDisplay]}>
              <Text
                style={
                  departureAtInput !== null
                    ? styles.departureDisplayText
                    : styles.departureDisplayPlaceholder
                }
              >
                {departureAtInput !== null
                  ? formatDeparture(departureAtInput)
                  : 'Choose a departure date and time'}
              </Text>
            </View>
            <View style={styles.departureButtonRow}>
              {[
                { mode: 'date', label: 'Date' },
                { mode: 'time', label: 'Time' },
              ].map((option) => {
                const isActive = departurePickerMode === option.mode;
                return (
                  <TouchableOpacity
                    key={option.mode}
                    style={[styles.departureButton, isActive && styles.departureButtonActive]}
                    onPress={() => handleToggleDeparturePicker(option.mode)}
                    activeOpacity={0.85}
                  >
                    <Text
                      style={[styles.departureButtonText, isActive && styles.departureButtonTextActive]}
                    >
                      {isActive ? 'Done' : `Pick ${option.label}`}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {departurePickerMode !== null && departureAtInput !== null && (
              <View style={Platform.OS === 'ios' ? styles.departurePickerBox : null}>
                <DateTimePicker
                  key={departurePickerMode}
                  value={departureAtInput}
                  mode={departurePickerMode}
                  display={Platform.OS === 'ios' ? 'spinner' : 'default'}
                  minimumDate={departurePickerMinimumDate}
                  minuteInterval={DEPARTURE_MINUTE_INTERVAL}
                  themeVariant="light"
                  textColor="#16213E"
                  locale="en-US"
                  onValueChange={(event, date) => handleDeparturePicked(date)}
                  onDismiss={() => setDeparturePickerMode(null)}
                />
              </View>
            )}

            {/* iOS has no Return key on a number pad, but pairing
                returnKeyType="done" with a number-pad keyboardType makes iOS
                show its own native "Done" toolbar above the keyboard, which
                fires onSubmitEditing below. That's what actually dismisses
                the keyboard on a real device, so no custom accessory bar is
                rendered here. Digits are filtered as typed so only whole
                numbers land. */}
            <Text style={styles.authLabel}>How many seats can you offer?</Text>
            <TextInput
              style={styles.input}
              placeholder={`Open seats (${MIN_SEATS}–${MAX_SEATS})`}
              placeholderTextColor="#9AA3B2"
              value={seatsInput}
              onChangeText={(text) => setSeatsInput(text.replace(/[^0-9]/g, ''))}
              onFocus={() => setDeparturePickerMode(null)}
              keyboardType="number-pad"
              returnKeyType="done"
              onSubmitEditing={Keyboard.dismiss}
            />
            {editingDriver !== null && editingDriver.matchedRiders.length > 0 && (
              <Text style={styles.formHint}>
                {editingDriver.matchedRiders.length} confirmed rider
                {editingDriver.matchedRiders.length === 1 ? '' : 's'} — total seats can't go
                below that.
              </Text>
            )}

            {formError !== '' && <Text style={styles.errorText}>{formError}</Text>}

            <TouchableOpacity
              style={[styles.saveDriverButton, isSubmittingDriver && styles.rideCardButtonDisabled]}
              onPress={handleSaveDriver}
              disabled={isSubmittingDriver}
              activeOpacity={0.85}
            >
              <Text style={styles.buttonText}>
                {editingRideId !== null ? 'Save Changes' : 'Post Ride'}
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.cancelButton}
              onPress={resetForm}
              activeOpacity={0.85}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Request a Ride form */}
        {currentUser.role === 'rider' && isAddingRider && (
          <View style={styles.section}>
            <View style={styles.sectionHeaderRow}>
              <View style={[styles.sectionAccent, styles.sectionAccentRider]} />
              <Text style={styles.sectionTitle}>Request a Ride</Text>
            </View>

            {isCurrentUserWaiting ? (
              <Text style={styles.formHint}>
                You're already listed in Looking for a Ride as{' '}
                <Text style={styles.formHintStrong}>{currentUser.name}</Text>. To ask for a seat,
                open a ride in Available Rides and tap Request This Ride.
              </Text>
            ) : (
              <>
                <Text style={styles.formHint}>
                  You'll be listed in Looking for a Ride as{' '}
                  <Text style={styles.formHintStrong}>{currentUser.name}</Text> so drivers can see
                  you need a lift. To ask for a seat on a specific ride, open it in Available
                  Rides and tap Request This Ride.
                </Text>

                <TouchableOpacity
                  style={styles.saveRiderButton}
                  onPress={handleSaveRider}
                  activeOpacity={0.85}
                >
                  <Text style={styles.buttonText}>Add Me to Looking for a Ride</Text>
                </TouchableOpacity>
              </>
            )}

            <TouchableOpacity
              style={styles.cancelButton}
              onPress={resetRiderForm}
              activeOpacity={0.85}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        )}
        </>
        )}
      </ScrollView>
      </TouchableWithoutFeedback>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: '#16213E',
  },

  // Dark navy header: brand row + inline stat chips
  header: {
    backgroundColor: '#16213E',
    paddingTop: 8,
    paddingBottom: 20,
    paddingHorizontal: 22,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 18,
  },
  logoMark: {
    width: 42,
    height: 42,
    borderRadius: 13,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  logoMarkText: {
    fontSize: 20,
    fontWeight: '800',
    color: '#16213E',
  },
  brandTextGroup: {
    flex: 1,
  },
  brandTitle: {
    fontSize: 21,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: 0.2,
  },
  brandTagline: {
    fontSize: 12.5,
    fontWeight: '500',
    color: 'rgba(255, 255, 255, 0.6)',
    marginTop: 2,
  },
  statRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 16,
    paddingVertical: 12,
  },
  statChip: {
    flex: 1,
    alignItems: 'center',
  },
  statChipNumber: {
    fontSize: 20,
    fontWeight: '800',
    color: '#fff',
  },
  statChipLabel: {
    fontSize: 11.5,
    fontWeight: '500',
    color: 'rgba(255, 255, 255, 0.65)',
    marginTop: 2,
  },
  statDivider: {
    width: 1,
    height: 28,
    backgroundColor: 'rgba(255, 255, 255, 0.15)',
  },

  // Scrollable page area
  scrollArea: {
    flex: 1,
    backgroundColor: '#F3F5F8',
  },
  container: {
    paddingHorizontal: 20,
    paddingTop: 22,
    paddingBottom: 32,
  },

  // Match Confirmed screen
  confirmationWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 24,
  },
  confirmationCard: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 22,
    padding: 24,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#EEF1F6',
    shadowColor: '#16213E',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  confirmationIconCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#3B6EF5',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
  },
  confirmationIcon: {
    fontSize: 26,
    fontWeight: '800',
    color: '#fff',
  },
  confirmationTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: '#16213E',
    marginBottom: 6,
  },
  confirmationSubtitle: {
    fontSize: 13.5,
    color: '#6B7280',
    textAlign: 'center',
    marginBottom: 20,
  },
  confirmationDetailsBox: {
    width: '100%',
    backgroundColor: '#F7F9FC',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 6,
    marginBottom: 20,
  },
  confirmationDetailRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  confirmationDetailLabel: {
    fontSize: 13,
    color: '#8A93A3',
    fontWeight: '600',
  },
  confirmationDetailValue: {
    fontSize: 14,
    color: '#1A2333',
    fontWeight: '700',
  },
  confirmationDetailDivider: {
    height: 1,
    backgroundColor: '#E8EBF0',
  },
  confirmationDoneButton: {
    alignSelf: 'stretch',
    marginBottom: 0,
  },

  // Ride Details screen
  detailsWrap: {
    flex: 1,
    paddingTop: 4,
  },
  detailsCard: {
    backgroundColor: '#fff',
    borderRadius: 22,
    padding: 20,
    borderWidth: 1,
    borderColor: '#EEF1F6',
    shadowColor: '#16213E',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  detailsBackRow: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginBottom: 16,
  },
  detailsBackArrow: {
    fontSize: 18,
    fontWeight: '700',
    color: '#3B6EF5',
    marginRight: 2,
  },
  detailsBackText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#3B6EF5',
  },
  detailsHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 18,
  },
  detailsHeaderText: {
    flex: 1,
    marginLeft: 12,
  },
  detailsDriverName: {
    fontSize: 19,
    fontWeight: '800',
    color: '#16213E',
  },
  detailsHeaderHint: {
    fontSize: 12.5,
    fontWeight: '500',
    color: '#8A93A3',
    marginTop: 2,
  },
  detailsMatchedEmpty: {
    fontSize: 14,
    color: '#8A93A3',
    marginBottom: 18,
  },
  cancelRideButton: {
    backgroundColor: '#FDECEC',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
  },
  cancelRideButtonText: {
    color: '#D64545',
    fontSize: 15,
    fontWeight: '700',
  },

  // Section headers (shared by Available Rides / Looking for a Ride / forms)
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  sectionAccent: {
    width: 4,
    height: 16,
    borderRadius: 2,
    marginRight: 8,
  },
  sectionAccentDriver: {
    backgroundColor: '#3B6EF5',
  },
  sectionAccentRider: {
    backgroundColor: '#F2994A',
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: '#16213E',
    letterSpacing: 0.1,
  },
  emptyCard: {
    backgroundColor: '#fff',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: '#EEF1F6',
    paddingVertical: 22,
    alignItems: 'center',
    marginBottom: 20,
  },
  emptyMessage: {
    fontSize: 14,
    color: '#8A93A3',
  },

  // Available Rides horizontal carousel
  rideCarousel: {
    paddingRight: 4,
    paddingBottom: 4,
    marginBottom: 20,
  },
  rideCard: {
    width: 220,
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 16,
    marginRight: 12,
    borderWidth: 1,
    borderColor: '#EEF1F6',
    shadowColor: '#16213E',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  rideCardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  rideCardName: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1A2333',
  },
  rideCardRouteRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
  },
  rideCardRouteIcon: {
    fontSize: 13,
    fontWeight: '700',
    color: '#3B6EF5',
    marginRight: 5,
  },
  rideCardDestination: {
    flex: 1,
    fontSize: 13.5,
    fontWeight: '600',
    color: '#3A4256',
  },
  rideCardTimeBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#F3F5F8',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginTop: 8,
    marginBottom: 8,
  },
  rideCardCounts: {
    fontSize: 12,
    fontWeight: '600',
    color: '#8A93A3',
    marginBottom: 12,
  },

  // Spike: request notice, pending request rows, accept / deny buttons
  noticeBox: {
    backgroundColor: '#EEF3FF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#D6E2FE',
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 16,
  },
  noticeText: {
    fontSize: 13.5,
    fontWeight: '600',
    color: '#16213E',
  },
  pendingList: {
    marginBottom: 18,
  },
  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF8F0',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#F7E3D1',
  },
  pendingInfo: {
    flex: 1,
  },
  pendingStatus: {
    fontSize: 12,
    fontWeight: '700',
    color: '#F2994A',
  },
  pendingReasonText: {
    fontSize: 12.5,
    fontStyle: 'italic',
    color: '#5B6472',
    marginTop: 2,
  },
  acceptButton: {
    backgroundColor: '#3B6EF5',
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginLeft: 6,
  },
  acceptButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
  },
  denyButton: {
    backgroundColor: '#FDECEC',
    borderRadius: 999,
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginLeft: 6,
  },
  denyButtonText: {
    color: '#D64545',
    fontSize: 13,
    fontWeight: '700',
  },
  rideCardTimeText: {
    fontSize: 11.5,
    fontWeight: '600',
    color: '#5B6472',
  },
  rideCardButton: {
    backgroundColor: '#3B6EF5',
    borderRadius: 999,
    paddingVertical: 11,
    alignItems: 'center',
  },
  rideCardButtonDisabled: {
    backgroundColor: '#E5E8EE',
  },
  rideCardButtonText: {
    color: '#fff',
    fontSize: 13.5,
    fontWeight: '700',
  },
  rideCardButtonTextDisabled: {
    color: '#9AA3B2',
  },

  // Reservation panel: pick a waiting rider to match with a driver
  reservationPanel: {
    backgroundColor: '#EEF3FF',
    borderRadius: 20,
    padding: 18,
    marginBottom: 20,
    borderWidth: 1,
    borderColor: '#D6E2FE',
  },
  reservationTitle: {
    fontSize: 15.5,
    fontWeight: '700',
    color: '#16213E',
  },
  reservationSubtitle: {
    fontSize: 12.5,
    color: '#5B6B8C',
    marginTop: 3,
    marginBottom: 14,
  },
  riderPickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: '#E4EBFC',
  },
  riderPickAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    marginRight: 10,
  },
  riderPickName: {
    flex: 1,
    fontSize: 14.5,
    fontWeight: '600',
    color: '#1A2333',
  },
  riderPickArrow: {
    fontSize: 18,
    color: '#9AA3B2',
  },

  // Driver / rider avatars (shared)
  avatarRing: {
    width: 50,
    height: 50,
    borderRadius: 25,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E8EFFE',
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#3B6EF5',
    alignItems: 'center',
    justifyContent: 'center',
  },
  riderAvatar: {
    backgroundColor: '#F2994A',
  },
  avatarText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },

  seatBadge: {
    backgroundColor: '#E8EFFE',
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  seatBadgeText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#3B6EF5',
  },

  // Looking for a Ride: wrapping chip row
  riderChipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 20,
  },
  riderChip: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#fff',
    borderRadius: 999,
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: '#F7E3D1',
  },
  riderChipAvatar: {
    width: 28,
    height: 28,
    borderRadius: 14,
    marginRight: 8,
  },
  riderChipName: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1A2333',
  },

  // Primary actions: side-by-side quick-action cards
  actionsRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  actionCard: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 18,
    paddingVertical: 16,
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: '#EEF1F6',
    borderBottomWidth: 3,
    shadowColor: '#16213E',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1,
  },
  actionCardDriver: {
    borderBottomColor: '#3B6EF5',
  },
  actionCardRider: {
    borderBottomColor: '#F2994A',
  },
  actionCardLabel: {
    fontSize: 15,
    fontWeight: '700',
    color: '#16213E',
  },
  actionCardHint: {
    fontSize: 12,
    color: '#8A93A3',
    marginTop: 3,
  },

  // Section containers (forms)
  section: {
    backgroundColor: '#fff',
    borderRadius: 20,
    padding: 18,
    marginBottom: 18,
    borderWidth: 1,
    borderColor: '#EEF1F6',
    shadowColor: '#16213E',
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },

  // Form inputs
  input: {
    borderWidth: 1,
    borderColor: '#DADFE6',
    borderRadius: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    marginBottom: 12,
    backgroundColor: '#FAFBFC',
  },
  errorText: {
    color: '#D64545',
    fontSize: 14,
    marginBottom: 12,
  },
  reasonInput: {
    minHeight: 64,
    textAlignVertical: 'top',
  },

  saveDriverButton: {
    backgroundColor: '#3B6EF5',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 12,
  },
  saveRiderButton: {
    backgroundColor: '#F2994A',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 12,
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  cancelButton: {
    backgroundColor: '#EDEFF2',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  cancelButtonText: {
    color: '#4B5563',
    fontSize: 16,
    fontWeight: '600',
  },

  // Sign-in screen
  authFlexWrap: {
    flex: 1,
  },
  authScrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
    paddingVertical: 32,
    backgroundColor: '#16213E',
  },
  authHeader: {
    alignItems: 'center',
    marginBottom: 28,
  },
  authTitle: {
    fontSize: 24,
    fontWeight: '800',
    color: '#fff',
    marginTop: 14,
  },
  authSubtitle: {
    fontSize: 13.5,
    color: 'rgba(255, 255, 255, 0.65)',
    marginTop: 6,
    textAlign: 'center',
  },
  authCard: {
    backgroundColor: '#fff',
    borderRadius: 22,
    padding: 20,
  },
  authLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: '#5B6472',
    marginBottom: 8,
    marginTop: 4,
  },
  authHint: {
    fontSize: 12,
    color: '#8A93A3',
    marginBottom: 16,
  },
  authReturningNotice: {
    backgroundColor: '#EEF3FF',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#D6E2FE',
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 12,
  },
  authReturningNoticeText: {
    fontSize: 13.5,
    fontWeight: '600',
    color: '#16213E',
  },
  authDisclaimer: {
    fontSize: 11.5,
    color: '#8A93A3',
    marginTop: 4,
    lineHeight: 16,
  },
  roleToggleRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 10,
  },
  roleToggleButton: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#DADFE6',
    paddingVertical: 12,
    alignItems: 'center',
    backgroundColor: '#FAFBFC',
  },
  roleToggleButtonActiveDriver: {
    backgroundColor: '#3B6EF5',
    borderColor: '#3B6EF5',
  },
  roleToggleButtonActiveRider: {
    backgroundColor: '#F2994A',
    borderColor: '#F2994A',
  },
  roleToggleText: {
    fontSize: 14.5,
    fontWeight: '700',
    color: '#5B6472',
  },
  roleToggleTextActive: {
    color: '#fff',
  },

  // Signed-in account row (header)
  accountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
  },
  accountText: {
    flex: 1,
    fontSize: 12.5,
    color: 'rgba(255, 255, 255, 0.7)',
  },
  accountTextStrong: {
    color: '#fff',
    fontWeight: '700',
  },
  roleBadge: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
    marginRight: 10,
  },
  roleBadgeDriver: {
    backgroundColor: 'rgba(59, 110, 245, 0.35)',
  },
  roleBadgeRider: {
    backgroundColor: 'rgba(242, 153, 74, 0.35)',
  },
  roleBadgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#fff',
  },
  // Solid-color variant for use on light (white card) backgrounds, like the
  // Profile screen, where the header's semi-transparent tint reads too pale.
  roleBadgeInlineDriver: {
    backgroundColor: '#3B6EF5',
    marginRight: 0,
  },
  roleBadgeInlineRider: {
    backgroundColor: '#F2994A',
    marginRight: 0,
  },
  accountActionButton: {
    marginLeft: 10,
  },
  profileLinkText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#fff',
  },
  logOutText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#fff',
  },

  // Wraps the scrollable page area so the keyboard can push content (and the
  // Save/Post Ride button) up instead of covering it.
  mainFlexWrap: {
    flex: 1,
  },

  // Full-ride indicators
  seatBadgeFull: {
    backgroundColor: '#FDECEC',
  },
  seatBadgeTextFull: {
    color: '#D64545',
  },
  fullPill: {
    backgroundColor: '#FDECEC',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  fullPillText: {
    color: '#D64545',
    fontSize: 13,
    fontWeight: '700',
  },
  yourRideTag: {
    fontSize: 11,
    fontWeight: '700',
    color: '#3B6EF5',
    marginBottom: 2,
  },

  // Self-service "Leave" / "Remove" buttons on a rider's own chip
  riderChipLeaveButton: {
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: '#FDECEC',
  },
  riderChipLeaveText: {
    color: '#D64545',
    fontSize: 11.5,
    fontWeight: '700',
  },

  // "Posting as ..." / "You'll be listed as ..." note at the top of a form
  formHint: {
    fontSize: 13.5,
    color: '#5B6472',
    lineHeight: 19,
    marginBottom: 14,
  },
  formHintStrong: {
    fontWeight: '700',
    color: '#16213E',
  },

  // Small Available Rides sort control
  sortRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: -2,
    marginBottom: 12,
  },
  sortLabel: {
    fontSize: 12.5,
    fontWeight: '600',
    color: '#8A93A3',
  },
  sortOption: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#DADFE6',
    backgroundColor: '#fff',
  },
  sortOptionActive: {
    backgroundColor: '#3B6EF5',
    borderColor: '#3B6EF5',
  },
  sortOptionText: {
    fontSize: 12.5,
    fontWeight: '700',
    color: '#5B6472',
  },
  sortOptionTextActive: {
    color: '#fff',
  },

  // "Loading rides…" text under the spinner in the empty card
  loadingMessage: {
    marginTop: 8,
  },

  // Owner's Edit Ride button on Ride Details (sits above Cancel Ride)
  editRideButton: {
    backgroundColor: '#EEF3FF',
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 4,
    marginBottom: 10,
  },
  editRideButtonText: {
    color: '#3B6EF5',
    fontSize: 15,
    fontWeight: '700',
  },

  // Departure date/time wheels in the Post Ride form
  departureDisplay: {
    justifyContent: 'center',
  },
  departureDisplayText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1A2333',
  },
  departureDisplayPlaceholder: {
    fontSize: 16,
    color: '#9AA3B2',
  },
  departureButtonRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 12,
  },
  departureButton: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#DADFE6',
    paddingVertical: 10,
    alignItems: 'center',
    backgroundColor: '#FAFBFC',
  },
  departureButtonActive: {
    backgroundColor: '#3B6EF5',
    borderColor: '#3B6EF5',
  },
  departureButtonText: {
    fontSize: 14,
    fontWeight: '700',
    color: '#3B6EF5',
  },
  departureButtonTextActive: {
    color: '#fff',
  },
  departurePickerBox: {
    backgroundColor: '#FAFBFC',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: '#DADFE6',
    marginBottom: 12,
    overflow: 'hidden',
  },
});
