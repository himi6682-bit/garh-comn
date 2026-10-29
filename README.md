# Garh-Comn

Garh-Comn is a small chat app for one private network. One computer or tablet runs the host. Everyone else opens a link, signs in, and talks. Messages stay on that host. Garh-Comn does not use the internet after it is installed.

People join from a phone or tablet browser on the same network, or from the Windows and Android apps. The host is a Windows PC or an Android tablet. A laptop running Node, or Termux, can host too. The chat screen is the same page in every case.

## Windows quick start

1. Install the **Node.js LTS** Windows installer from [https://nodejs.org](https://nodejs.org). Accept the defaults, including the option that adds Node to your PATH.
2. Unzip this project. Open **PowerShell** or **Command Prompt** in that folder. `node -v` should print a version.
3. Install and start:

```powershell
npm install
npm start
```

4. The first time, Garh-Comn asks you to type an admin password (8 or more characters). It is visible as you type. That password is not built in. If the window is not interactive, a random password is printed once in that window and saved in `data\admin-password.txt`. Delete that file after you sign in.
5. The window prints addresses under **On this network**, for example `http://192.168.1.20:8787`. On each phone, connect to the same Wi-Fi or Ethernet network and open that address in the browser.
6. Sign in as `admin` with the password from step 4. Use **Admin** to create everyone else's account.

Stop the host with Ctrl+C in that window. Only run one copy at a time.

## Try it on a laptop

You need Node.js 18 or newer.

```bash
npm install
npm start
```

The first start asks for the admin password in the terminal. You can instead copy `config.example.json` to `config.json` and set `adminPassword` yourself before `npm start`. Leave it empty to be asked, or to get a one-time random password when there is no terminal.

Open the address it prints, starting with `http://127.0.0.1:8787`. Sign in as `admin`. Open **Admin**, create two people, and give them the usernames and passwords. Use a private browser window to sign in as the second person on the same laptop.

The admin screen lists every address for this computer. Ethernet and Wi-Fi are labeled separately. A phone on the same network opens one of those addresses.

`npm start` listens on `0.0.0.0`, so it accepts connections on every interface, not only Wi-Fi.

Stop it with Ctrl+C. Chat history is in `data/porch.db`. Copy that file if you want a backup.

### Demo mode

For a throwaway try only, not on a network you care about:

```bash
GARH_DEMO=1 npm start
```

On Windows PowerShell that is `$env:GARH_DEMO=1; npm start`. The admin username is `admin` and the password is `garh-demo`. The console says **DEMO MODE**. This password is used only when you turn demo mode on and you have not already created the admin account.

```bash
npm test
npm run test:java
```

## Install on Windows

Use `garh-comn.exe`. It does not need Node installed. The first window asks whether this computer hosts the chat or joins a tablet that already does.

1. Copy the exe to the PC. Double-click it.
2. Windows SmartScreen says the publisher is unknown, because the exe is not code-signed. Choose **More info**, then **Run anyway**.
3. If Windows Firewall asks, allow Garh-Comn on **private** networks. That opens the chat port (TCP 8787, or the next free port) and host discovery (UDP 45878). Do not allow it on public networks.
4. First run on a host: type a display name, leave the username as `admin` unless you want another one, and type a password of 8 or more characters. It is visible as you type. That password is not built into the app. Choose **Host on this computer**. The chat window opens. Sign in with that username and password.
5. The admin screen lists Ethernet and Wi-Fi addresses. Phones on the same network open one of those in a browser, or another Windows copy chooses **Join a host** and types the address.
6. Closing the chat window leaves the host running. Open it again from the tray icon. **Quit Garh-Comn** in the tray menu stops the host.

The next time you host, the password fields are hidden. The account already exists in `%APPDATA%\garh-comn\data`.

To build the exe yourself, from this folder on any OS with Node 18:

```bash
npm install
npm install --no-save electron electron-builder
npm run build:win
```

The file is `dist/garh-comn.exe`. Signing it (an Authenticode certificate) is what removes the SmartScreen warning. This build does not sign it.

## Install on the Android tablet

Use `garh-comn.apk` on the Lenovo tablet (Android 16). One app hosts the server and shows the chat, or joins another host. The server runs in a foreground service (`remoteMessaging`, the type Android 16 still allows from boot), shows a notification with every LAN address, asks for notification permission, and asks to ignore battery optimization. **Start hosting when the tablet turns on** is on unless you turn it off. USB Ethernet and Wi-Fi are listed separately.

The APK does not embed Node. Official `nodejs-mobile` builds are aligned for 4 KB pages, and Android 16 devices can use 16 KB pages, so those binaries are refused. The tablet app runs the same protocol and the same web UI in a Java server instead.

1. Copy the APK to the tablet (USB, or a browser download from a computer on the network).
2. Open **Settings → Apps → Special app access → Install unknown apps**. Allow it for the Files app (or for Chrome, if that is what downloaded the APK).
3. Open the APK and install it.
4. Open **Garh-Comn**. The first time, type your display name, the admin username, and a password of 8 or more characters. Choose **Host on this tablet**.
5. Allow notifications when Android asks. Allow the battery-optimization exemption when that screen appears (or tap **Allow Garh-Comn to ignore battery limits**). The chat page opens in the app. Sign in with the password you just chose.
6. The notification and the bar above the chat list the Ethernet and Wi-Fi addresses. Other phones open one of those, or install this same APK and choose **Join a host**.

The debug APK is signed with the Android debug key. That is enough to install and update this build. A Play-style release key is separate, and you must keep using the same key for updates:

```bash
keytool -genkeypair -v -keystore android/garh-comn-release.jks -alias garh -keyalg RSA -keysize 2048 -validity 10000
```

Put the store passwords in `android/keystore.properties` (do not commit that file):

```
storeFile=garh-comn-release.jks
storePassword=your-store-password
keyAlias=garh
keyPassword=your-key-password
```

`storeFile` is relative to the `android` folder. Keep the `.jks` file and `keystore.properties` off the shared copy of this project.

Then `cd android && gradle assembleRelease`. The release APK is signed with that key. Without the properties file, `assembleRelease` still builds, but the APK is unsigned and Android will not install it.

To rebuild the debug APK: install Android SDK platform 36 and build-tools 36, then `npm run build:android`. Output: `dist/garh-comn.apk`.

## Termux on the tablet

Use this if you want the Node server directly instead of the APK. The tablet needs a network connection once, for `npm install`. After that, Garh-Comn runs offline. These libraries are pure JavaScript, so you can also copy the whole project folder, including `node_modules`, from a laptop.

1. Install **Termux** and **Termux:Boot** from F-Droid. Do not use the Play Store build of Termux. It is obsolete.
2. Open Termux and run:

```bash
pkg update
pkg install nodejs
```

3. Copy the project to the tablet, for example as a zip over USB, then:

```bash
termux-setup-storage
cd ~
unzip /sdcard/Download/garh-comn.zip
cd garh-comn
npm install
```

4. Start it. If this is a normal Termux window, type an admin password when asked. To choose it ahead of time, copy `config.example.json` to `config.json` and set `adminPassword`.
5. Start it:

```bash
npm start
```

6. Write down the Ethernet and Wi-Fi addresses it prints.
7. Start on boot:

```bash
pkg install termux-api
mkdir -p ~/.termux/boot
cp ~/garh-comn/scripts/termux-boot.sh ~/.termux/boot/start-garh-comn.sh
chmod +x ~/.termux/boot/start-garh-comn.sh
```

Install the **Termux:API** app from F-Droid as well, or the wake lock in that script does nothing. Open Termux:Boot once so it is allowed to run. In Android settings, set Termux and Termux:Boot to **Unrestricted** battery.

The log is `~/garh-comn/data/garh-comn.log`. A boot script has no keyboard, so put `adminPassword` in `config.json` before the first boot, or let the first boot print a random password into that log. To see the address later:

```bash
npm run address
```

Stop a boot-started server with:

```bash
pkill -f "node server/index.js"
```

If you forget the admin password, put the new one in `config.json` and run:

```bash
node server/index.js --reset-admin
```

Remove that habit afterward. The command resets the password on every start if you leave it in a boot script.

## Hardware

```
[tablet host] -- USB-C hub (Ethernet + charger) --+
                                                  [switch]
[phone] -- Wi-Fi -- [access point] -- Ethernet ---+
[phone] -- USB Ethernet ---------------------------+
```

- Use a USB-C hub with **Ethernet and power delivery** so the host tablet charges. A bare Ethernet adapter does not charge the tablet.
- A PoE switch can power a PoE access point. It does **not** charge phones or the tablet. Phones are not PoE devices. Give each phone its own battery or charger.
- Prefer a plain Ethernet switch over guest Wi-Fi. Many routers isolate Wi-Fi clients from each other, and then phones cannot reach the host. If you use Wi-Fi, turn off AP / client isolation.
- Give the host a fixed address. On the tablet: **Settings → Network → Internet** (or Ethernet) → the gear icon → **IP settings → Static**. Use an address outside the router's DHCP pool, for example `192.168.1.20` if the router is `192.168.1.1` and DHCP starts at `.100`. Gateway is the router. DNS can be the gateway too. Garh-Comn does not need the internet, but Android asks for a DNS address.
- Reserving the address in the router's DHCP settings is easier when the router allows it.

## HTTPS

HTTP is enough on a network you control. Anyone on that network who can see the traffic can read it. If you want encryption, on the host:

```bash
npm run cert
```

Set `"https": true` in `config.json` and start again. Each phone must open the `https://` address once, choose **Advanced**, and continue. The certificate is self-signed. Check that the address you opened matches the one printed by the host.

## What the admin can do

- Create people. Usernames are 3–32 letters, numbers, dots, dashes, or underscores. Passwords are 8–72 characters. Tell the person the password. Garh-Comn does not show it again.
- Disable an account. They are signed out immediately and cannot sign in until you enable them.
- Delete an account. Old messages stay, shown as "Deleted user". You cannot delete the admin.
- Reset a password. That person is signed out.
- Create a group. **Everyone** already exists and new people are added to it.
- Rename a group, add or remove people, or delete it. Open the group and choose **Info**, then **Delete group**, and confirm. The same **Delete group** button is on each group in **Admin**, under **Groups**. **Everyone** cannot be deleted. People still in the group see it disappear immediately.
- Send photos and common files up to 8 MB (`maxUploadMb` in `config.json`).

Everyone else can use direct chats, Everyone, and any group they are in. They see who is online, who is typing, and sent / delivered / read marks. History is still there after the host restarts. The page reconnects if the network drops.

## Tests

```bash
npm test
npm run test:java
```

`npm test` covers sign-in, rate limiting, creating and disabling people, direct messages, the Everyone group, delivery and read marks, a photo, kicking a signed-in person, and history after a restart. It also checks that an Ethernet address is kept next to Wi-Fi and that the default bind address is `0.0.0.0`.

`npm run test:java` checks the Android host's server the same way: sign-in, direct and group delivery over the WebSocket, read marks, the Ethernet address list, and history after a restart.

## Limits

Garh-Comn is for a room, a house, or a small office on one network. It is not a public internet service. Anyone who can hold the host can read `data/porch.db`. Keep the host with the admin.
