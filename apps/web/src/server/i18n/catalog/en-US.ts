/**
 * The en-US message catalog (FR-I18N-1).
 *
 * Every user-visible string — UI and e-mail — lives here. The shape *is* the
 * contract: adding a locale means adding one object that satisfies
 * {@link Catalog}, and TypeScript then names every string that is missing, so
 * a translation cannot ship half-done.
 *
 * Parameterised strings are functions rather than `{placeholder}` templates,
 * because a function signature is checked and a template string is not: a
 * translator who drops `{name}` gets a compile error instead of a page that
 * says "Hi {name}".
 *
 * Dates are deliberately absent: they render in the browser's locale (FR-I18N-1).
 */

export const enUS = {
  locale: "en-US",

  common: {
    appName: (siteName: string) => siteName,
    signIn: "Sign in",
    signUp: "Create account",
    signOut: "Sign out",
    cancel: "Cancel",
    continue: "Continue",
    save: "Save changes",
    back: "Back",
    email: "E-mail address",
    password: "Password",
    currentPassword: "Current password",
    newPassword: "New password",
    confirmPassword: "Confirm new password",
    firstName: "First name",
    lastName: "Last name",
    name: "Name",
    showPassword: "Show password",
    hidePassword: "Hide password",
    loading: "Working…",
    required: "Required",
  },

  auth: {
    signIn: {
      title: "Sign in",
      submit: "Sign in",
      forgotPassword: "Forgot your password?",
      noAccount: "Need an account?",
      socialDivider: "or continue with",
      withProvider: (provider: string) => `Continue with ${provider}`,
      // SEC-7: one message for wrong password and unknown address alike.
      failed: "That e-mail address and password combination is not correct.",
      unavailable: "This account is not available.",
      // FR-AUTH-5: not a failure — the session is valid but too old for what
      // was being attempted.
      reauth: "Sign in again to continue. It has been a while.",
      required: "Sign in to continue.",
    },
    signUp: {
      title: "Create your account",
      submit: "Create account",
      haveAccount: "Already have an account?",
      passwordHint: (min: number) =>
        `At least ${min} characters. Longer is better than complicated.`,
      approvalNotice:
        "New accounts are reviewed by an administrator before they can be used.",
      verifyNotice: "We will send you a link to confirm your address.",
      done: "Account created.",
      domainNotAllowed: "Registration is not open to this e-mail domain.",
    },
    verifyEmail: {
      title: "Confirm your e-mail address",
      pending: (email: string) =>
        `We sent a link to ${email}. Open it to finish setting up your account.`,
      success: "Your e-mail address is confirmed.",
      expired: "That link has expired.",
      used: "That link has already been used.",
      invalid: "That link is not valid.",
      resend: "Send a new link",
      resent: "If that address needs confirming, a new link is on its way.",
    },
    forgotPassword: {
      title: "Reset your password",
      description:
        "Enter your e-mail address and we will send you a link to set a new password.",
      submit: "Send reset link",
      // SEC-7: identical whether or not the account exists.
      done: "If there is an account for that address, a reset link is on its way.",
    },
    resetPassword: {
      title: "Choose a new password",
      submit: "Set new password",
      success: "Your password has been changed. Sign in with it now.",
      expired: "That reset link has expired. Request a new one.",
      used: "That reset link has already been used. Request a new one.",
      invalid: "That reset link is not valid. Request a new one.",
      mismatch: "The two passwords do not match.",
      revokedNotice: "Signing in again will be needed on your other devices.",
    },
    changePassword: {
      title: "Change your password",
      forcedTitle: "Choose a new password",
      forcedDescription:
        "Your account is set up with a temporary password. Choose your own before continuing.",
      submit: "Change password",
      success: "Your password has been changed.",
      wrongCurrent: "That is not your current password.",
    },
    twoFactor: {
      title: "Two-factor authentication",
      description: "Enter the six-digit code from your authenticator app.",
      backupDescription:
        "Enter one of the backup codes you saved when you turned on two-factor authentication. Each code works once.",
      code: "Authentication code",
      submit: "Verify",
      trustDevice: (days: number) =>
        `Do not ask again on this device for ${days} days`,
      useBackupCode: "Use a backup code instead",
      useAuthenticator: "Use your authenticator app instead",
      backupCode: "Backup code",
      invalid: "That code is not correct.",
      lockedOut: "Too many attempts. Wait a few minutes and try again.",
      expired: "That took too long. Sign in again to get a new code prompt.",
    },
    pendingApproval: {
      title: "Waiting for approval",
      description:
        "Your account has been created and is waiting for an administrator to approve it. You will get an e-mail when it is ready.",
      descriptionNoEmail:
        "Your account has been created and is waiting for an administrator to approve it.",
    },
    banned: {
      title: "This account is suspended",
      withReason: (reason: string) => `Reason: ${reason}`,
      untilNotice: "Access will return automatically when the suspension ends.",
      contact: (supportEmail: string) =>
        `If you think this is a mistake, contact ${supportEmail}.`,
      generic: "If you think this is a mistake, contact your administrator.",
    },
    signOut: {
      title: "Signed out",
      description: "You have been signed out.",
      signInAgain: "Sign in again",
    },
  },

  consent: {
    title: (clientName: string) => `${clientName} wants to access your account`,
    description: "Review what it is asking for before you continue.",
    allow: "Allow",
    deny: "Deny",
    denied: "You did not allow that application.",
    scopes: {
      openid: "Confirm who you are",
      profile: "See your name and profile details",
      email: "See your e-mail address",
      offline_access: "Stay signed in when you are away",
    } as Record<string, string>,
    unknownScope: (scope: string) => `Access described as "${scope}"`,
    moreInfo: "More about this application",
    terms: "Terms of service",
    privacy: "Privacy policy",
    escalation:
      "This application is asking for more than you previously allowed.",
  },

  endSession: {
    title: "Sign out?",
    description: (clientName: string) =>
      `${clientName} has asked to sign you out of ${"the identity provider"}.`,
    confirm: "Sign out",
    cancel: "Stay signed in",
  },

  errors: {
    notFound: {
      title: "Page not found",
      description: "The page you were looking for is not here.",
    },
    forbidden: {
      title: "Not allowed",
      description: "You do not have access to this page.",
    },
    serverError: {
      title: "Something went wrong",
      description: "The request could not be completed. Try again in a moment.",
    },
    rateLimited: {
      title: "Too many attempts",
      description: "Wait a little before trying again.",
      retryAfter: (seconds: number) =>
        `Try again in about ${Math.ceil(seconds / 60)} minute(s).`,
    },
    oauth: {
      title: "This application could not be signed in",
      unknownClient: "This application is not registered with us.",
      // FR-OIDC-4: never redirect to an unregistered URI; explain instead.
      invalidRedirect:
        "The address this application asked us to return to is not one of its registered addresses.",
      description:
        "Nothing was shared. Go back to the application and try again.",
      expired:
        "This sign-in request took too long. Start again from the application.",
    },
  },

  account: {
    title: "Your account",
    // FR-ADMIN-5: an impersonated session must be obvious on every page.
    impersonationBanner:
      "An administrator is signed in as you. Everything you do here is recorded.",
    nav: {
      profile: "Profile",
      security: "Security",
      sessions: "Sessions",
      apiKeys: "API keys",
      consents: "Connected applications",
    },
    profile: {
      title: "Profile",
      saved: "Profile updated.",
      description: "Your name as it appears to applications you sign in to.",
      submit: "Save",
      roles: "Roles",
      noRoles: "No roles.",
      emailVerified: "Confirmed",
      emailUnverified: "Not confirmed",
    },
    security: {
      title: "Security",
      changePassword: {
        title: "Password",
        description: "Change the password you sign in with.",
        submit: "Change password",
      },
    },
    changeEmail: {
      title: "Change e-mail address",
      newEmail: "New e-mail address",
      description:
        "We will send a confirmation link to the new address before switching.",
      submit: "Send confirmation",
      sent: "Check the new address for a confirmation link.",
    },
    sessions: {
      title: "Where you are signed in",
      description:
        "Every browser and device with a live session. Signing one out takes effect immediately.",
      signedIn: "Signed in",
      expires: "Expires",
      unknownDevice: "Unknown device",
      revoked: "That session has been signed out.",
      current: "This device",
      revoke: "Sign out",
      revokeAll: "Sign out everywhere else",
      empty: "No other sessions.",
    },
    apiKeys: {
      title: "API keys",
      description:
        "A key acts as you. Anyone holding it can do what you can do.",
      create: "Create key",
      keyName: "What is this key for?",
      expires: "Expires",
      neverShownAgain: "Copy this key now — it will not be shown again.",
      revoke: "Revoke",
      empty: "No API keys yet.",
      created: "Created",
      never: "Never",
      lastUsed: "Last used",
      neverUsed: "Never used",
      revoked: "That key has been revoked.",
      expiresIn: "Expires in",
      expiryHint: (days: number) => `Up to ${days} days.`,
      outOfRange: "Choose an expiry within the allowed range.",
      days: "days",
    },
    twoFactor: {
      title: "Two-factor authentication",
      enable: "Turn on",
      disable: "Turn off",
      scanQr:
        "Scan this with your authenticator app, then enter the code it shows.",
      backupCodes: "Backup codes",
      backupCodesNotice: "Save these somewhere safe. Each one works once.",
      enabled: "Two-factor authentication is on.",
      disabled: "Two-factor authentication is off.",
      description:
        "Ask for a code from your authenticator app as well as your password.",
      confirm: "Enter the code to finish",
      confirmSubmit: "Confirm",
      passwordToDisable: "Enter your password to turn it off",
      manualEntry: "Or enter this key by hand:",
      turnedOn: "Two-factor authentication is now on.",
      turnedOff: "Two-factor authentication is now off.",
    },
    consents: {
      title: "Connected applications",
      revoke: "Disconnect",
      empty: "No applications are connected.",
      revokeNotice: "Disconnecting also signs the application out.",
      description:
        "Applications you have allowed to sign you in and see parts of your account.",
      scopes: "Allowed",
      connectedOn: "Connected",
      revoked: "That application has been disconnected.",
    },
  },

  email: {
    // Subject + body for each of the nine templates (FR-MAIL-1). Every link is
    // built from `server.baseUrl` only (SEC-1).
    verify: {
      subject: (siteName: string) =>
        `Confirm your e-mail address for ${siteName}`,
      heading: "Confirm your e-mail address",
      body: (siteName: string) =>
        `Someone — hopefully you — created an account at ${siteName} with this address. Confirm it to finish.`,
      action: "Confirm e-mail address",
      expiry: "This link works once and expires in 24 hours.",
      ignore: "If this was not you, you can ignore this message.",
    },
    resetPassword: {
      subject: (siteName: string) => `Reset your ${siteName} password`,
      heading: "Reset your password",
      body: "Use the link below to choose a new password.",
      action: "Choose a new password",
      expiry: (minutes: number) =>
        `This link works once and expires in ${minutes} minutes.`,
      ignore:
        "If you did not ask for this, nothing has changed and you can ignore this message.",
    },
    setPassword: {
      subject: (siteName: string) => `Set up your ${siteName} account`,
      heading: "Set your password",
      body: (siteName: string) =>
        `An administrator created an account for you at ${siteName}.`,
      action: "Set your password",
      expiry: (minutes: number) =>
        `This link works once and expires in ${minutes} minutes.`,
    },
    pendingSignUp: {
      subject: (siteName: string) =>
        `Someone is waiting for approval on ${siteName}`,
      heading: "A new account is waiting for approval",
      body: (email: string) =>
        `${email} has signed up and cannot sign in until an administrator approves them.`,
      action: "Review pending accounts",
    },
    approved: {
      subject: (siteName: string) => `Your ${siteName} account is ready`,
      heading: "Your account has been approved",
      body: (siteName: string) => `You can now sign in to ${siteName}.`,
      action: "Sign in",
    },
    rejected: {
      subject: (siteName: string) => `About your ${siteName} account request`,
      heading: "Your account request was not approved",
      body: "An administrator did not approve this account request.",
      contact: (supportEmail: string) =>
        `If you have questions, contact ${supportEmail}.`,
    },
    passwordChanged: {
      subject: (siteName: string) => `Your ${siteName} password was changed`,
      heading: "Your password was changed",
      body: "If you did this, there is nothing to do.",
      warning:
        "If you did not, reset your password immediately and contact your administrator.",
      action: "Reset your password",
    },
    twoFactorChanged: {
      subject: (siteName: string, enabled: boolean) =>
        `Two-factor authentication was ${enabled ? "turned on" : "turned off"} for your ${siteName} account`,
      headingEnabled: "Two-factor authentication is on",
      headingDisabled: "Two-factor authentication is off",
      body: "If you did this, there is nothing to do.",
      warning: "If you did not, contact your administrator immediately.",
    },
    apiKeyCreated: {
      subject: (siteName: string) =>
        `A new API key was created on your ${siteName} account`,
      heading: "A new API key was created",
      body: (keyName: string) => `A key named "${keyName}" can now act as you.`,
      warning: "If you did not create it, revoke it and change your password.",
      action: "Review your API keys",
    },
    footer: {
      sentBy: (siteName: string) => `Sent by ${siteName}.`,
      doNotReply: "This message is automated; replies are not read.",
      linkFallback:
        "If the button does not work, copy this address into your browser:",
    },
  },
} as const

export type Catalog = typeof enUS
