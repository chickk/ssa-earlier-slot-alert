# SSA Earlier Slot Alert

Small Playwright script that opens a real Chrome window, lets you manually sign in to SSA with Face ID/passkey, then checks several ZIP codes in sequence for appointment dates earlier than your current appointment.

This script does not bypass Face ID, passkeys, CAPTCHA, or other login protections. It only automates navigation after you have signed in yourself.

## Setup

```bash
npm install
npx playwright install chromium
cp config.example.json config.json
```

Edit `config.json`:

- `zipCodes`: ZIP codes to check.
- `currentAppointmentDate`: your current appointment date, in `YYYY-MM-DD`.
- `checkEveryMinutes`: how long to wait between full rounds.
- `betweenZipDelayMs`: delay between ZIP searches.

## Run

```bash
npm start
```

The first time:

1. Chrome opens.
2. Sign in to SSA manually.
3. Navigate to the ZIP-code page that says `Find Available Appointments`.
4. Return to the terminal and press Enter.

The script will then run one full round across all ZIP codes, wait, and repeat.

## Notes

- Keep the check interval conservative. Five minutes or longer is recommended.
- If your SSA session expires, complete login manually again in the opened browser.
- The SSA page can change. If the script cannot find the ZIP input or Next button, update the selectors in `src/monitor.js`.
