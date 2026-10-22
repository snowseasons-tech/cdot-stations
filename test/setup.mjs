// Loaded before every test file (see the "test" script): the tests must not depend on the developer's environment.
// If these were set (for example VAPID keys exported in a terminal that also runs the app), createApp would pick them
// up as defaults and many tests would fail for reasons unrelated to the code. Tests pass what they need explicitly.
for (const name of [
  'STATUS_TOKEN', 'STATUS_FILE', 'SUBSCRIPTIONS_FILE', 'TRUST_PROXY', 'HOST', 'PORT',
  'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'ALLOW_OPEN_WRITES',
]) delete process.env[name];
