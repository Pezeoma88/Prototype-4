# CarpoolBoard - Prototype 4

CarpoolBoard is a mobile carpool application designed to help users offer rides and request rides from other users. Prototype 4 focuses on persistent data, improving the ride creation process, and continuing improvements based on user testing.

## Prototype 4 Updates

For Prototype 4, I made several major updates to CarpoolBoard:

- Added Supabase for persistent data storage
- Profiles are now stored in a shared database
- Rides are saved and restored after closing and reopening the app
- Ride requests are stored in the database
- Drivers can edit existing rides
- Drivers can cancel and remove rides
- Added a scrolling date and time picker for selecting departure times
- Added Departure Time sorting
- Added loading and refresh behavior for retrieving ride data
- Continued improvements based on previous user testing

## Persistent Data

CarpoolBoard uses Supabase to store:

- User profiles
- Posted rides
- Ride requests and their status

I chose Supabase because the data remains available after the app is closed and reopened. It also allows the ride board to be shared between different users instead of storing the information only on one device.

## Ride Data States

The persisted ride data can move through several states:

1. Ride does not exist
2. Ride is created and saved
3. Ride is restored when the app is reopened
4. Ride is being modified
5. Modified ride is saved
6. Ride is removed
7. The board returns to an empty state when no rides remain

A hand-drawn state diagram showing these states is included with the Prototype 4 assignment submission.

## Date and Time Picker

The previous free-text departure time field was replaced with a native date and time picker. On iOS, users can scroll through the date and time using the native wheel-style picker.

The selected departure date and time are stored in Supabase and restored when the app is reopened.

## Ride Request Flow

Riders can request a specific posted ride. Requests can have the following states:

- Pending
- Accepted
- Denied
- Cancelled

When a driver accepts a request, the rider becomes a confirmed passenger and the number of available seats is updated.

## User Testing Improvements

Previous user testing led to several improvements that remain in Prototype 4:

- Users cannot request their own rides
- Account names are automatically used when posting or requesting rides
- Ride posting uses clearer wording
- Seat counts are limited from 1 to 7
- Rides can be sorted
- Driver and Rider roles are kept separate

## Testing
To test the app click on the expo link or scan the QR Code
https://expo.dev/preview/update?message=Prototype+4+user+testing&updateRuntimeVersion=1.0.0&createdAt=2026-10-01T19%3A31%3A06.387Z&slug=exp&projectId=0e5d81b8-c9ef-4e3a-873f-83c78eb6d72c&group=06388dc8-5bf9-4cb8-9a5f-7af5a8d75f4d

<img width="225" height="212" alt="image" src="https://github.com/user-attachments/assets/4821155c-5c3b-49ac-b91f-5ce00c535f0a" />



For Android users scan the QR Code or click the link.
https://expo.dev/accounts/smu-c3-mobile-fall-26/projects/CarpoolBoard/builds/c96fd5e7-c0fe-4e2e-a624-863dce70757c

<img width="297" height="285" alt="image" src="https://github.com/user-attachments/assets/1a60caa7-708a-4220-a3e1-3f6b04a903cd" />



## Technology

CarpoolBoard is built with:

- React Native
- Expo
- JavaScript
- Supabase
- EAS / Expo

## Current Prototype

Prototype 4 demonstrates persistent shared data across app sessions while continuing to develop the Driver and Rider workflow of CarpoolBoard.
