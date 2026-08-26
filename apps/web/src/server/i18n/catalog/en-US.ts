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
    close: "Close",
    copy: "Copy",
    copied: "Copied",
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
    yes: "Yes",
    no: "No",
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
      // D57: *not* a credential failure, and it must not read as one. The
      // request was refused before the password was looked at, because the
      // browser is on an address the deployment does not know.
      untrustedOrigin:
        "This page was opened from a web address this server does not recognise, so the sign-in was refused. Open it from the server's own address and try again.",
      unavailable: "This account is not available.",
      // FR-AUTH-5: not a failure — the session is valid but too old for what
      // was being attempted.
      reauth: "Sign in again to continue. It has been a while.",
      // D63: the same bounce, from a form. Saying so is the difference
      // between signing in again and starting the form over from memory.
      reauthDraft:
        "Sign in again to continue. It has been a while — what you typed is kept.",
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
      // A spent token's row is deleted, so "already used" and "never existed"
      // are the same observation (D65). The wording covers both rather than
      // claiming a distinction the page cannot make.
      invalid:
        "That link is not valid. It may already have been used — if so, your password is set and you can sign in.",
      mismatch: "The two passwords do not match.",
      revokedNotice: "Signing in again will be needed on your other devices.",
      // D65: the page names the account, and the invitation variant says who
      // the link is from rather than promising to sign other devices out of
      // an account nobody has ever signed in to.
      forAccount: (email: string) => `This link is for ${email}.`,
      welcomeTitle: "Set your password",
      welcomeDescription: (siteName: string) =>
        `An administrator created an account for you at ${siteName}. Choose a password to finish.`,
      expiredAdmin:
        "That link has expired. Ask your administrator for a new one.",
      invalidAdmin:
        "That link is not valid. It may already have been used — if so, your password is set and you can sign in. Otherwise, ask your administrator for a new one.",
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

  /**
   * First-run setup (**D52**).
   *
   * Written for the person who has just started a container and has no idea
   * what it wants from them: it says why the page exists, what happens next,
   * and that it will not be there again.
   */
  setup: {
    title: "Set this server up",
    description:
      "Nobody has an account here yet. The first one you create is an administrator.",
    submit: "Create first admin account",
    footnote:
      "This page is only here while the server has no users. It disappears as soon as this account exists.",
    invalidEmail: "Enter an e-mail address.",
    missingName: "Enter a first and last name.",
    // Not `common.confirmPassword` ("Confirm new password"): on the first-run
    // wizard there is no old one for it to be new against.
    confirmPassword: "Confirm password",
    alreadyDone: "This server is already set up. Sign in instead.",
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
    // D66: the banner said what was happening and offered no way out, so an
    // impersonation ended by expiring or by signing out — which signs the
    // administrator out too.
    stopImpersonating: "Stop impersonating",
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
      nameDerived:
        "Built from your first and last name. Change those and it follows.",
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

  /**
   * The admin area (FR-ADMIN-2..6).
   *
   * Written for someone who has to explain what they did afterwards: every
   * destructive action names its consequence rather than its mechanism, and
   * the refusals say what to do instead ("give another account an admin role
   * first") rather than only what went wrong.
   */
  admin: {
    title: "Administration",
    forbidden: {
      title: "You do not have access to this",
      description:
        "This area is for administrators. If you think that is a mistake, ask whoever set this server up.",
      back: "Back to your account",
    },
    nav: {
      dashboard: "Overview",
      users: "Users",
      clients: "Applications",
      roles: "Roles",
      audit: "Audit",
      system: "System",
    },
    dashboard: {
      title: "Overview",
      users: "Users",
      pending: "Waiting for approval",
      active: "Active",
      banned: "Suspended",
      admins: "Administrators",
      sessions: "Live sessions",
      clients: "Applications",
      signIns: "Sign-ins (24 h)",
      failures: "Failed sign-ins (24 h)",
      warningsTitle: "Configuration warnings",
      pendingCta: (count: number) =>
        count === 1
          ? "1 account is waiting for a decision."
          : `${count} accounts are waiting for a decision.`,
      review: "Review them",
    },
    users: {
      title: "Users",
      search: "Search by name or e-mail",
      searchAction: "Search",
      filterStatus: "Status",
      filterRole: "Role",
      any: "Any",
      create: "Create a user",
      empty: "No users match that.",
      columns: {
        user: "User",
        status: "Status",
        roles: "Roles",
        created: "Created",
      },
      showing: (from: number, to: number, total: number) =>
        `${from}–${to} of ${total}`,
      previous: "Previous",
      next: "Next",
      pageSize: "Per page",
    },
    status: {
      pending: "Pending",
      active: "Active",
      rejected: "Rejected",
      banned: "Suspended",
      unverified: "E-mail not confirmed",
      mustChangePassword: "Must change password",
      twoFactor: "Two-factor on",
    },
    detail: {
      identities: "Sign-in methods",
      noIdentities: "Password only.",
      sessions: "Sessions",
      noSessions: "Not signed in anywhere.",
      apiKeys: "API keys",
      noApiKeys: "No API keys.",
      events: "Recent activity",
      started: "Started",
      ip: "IP address",
      device: "Device",
      keyCreated: "Created",
      notifyRejection: "Send them an e-mail about it",
      noEvents: "Nothing recorded yet.",
      unknownRoles: (roles: string) =>
        `Holds roles that are not in the catalog and are dropped from claims: ${roles}. Add them to roles.jsonc, or change them here.`,
      profileConflict:
        "A social sign-in was refused because this address already belongs to this account. Link the provider from the account page instead.",
      impersonatedSession: "Impersonated",
    },
    actions: {
      title: "Actions",
      approve: "Approve",
      reject: "Reject",
      ban: "Suspend",
      banReason: "Reason (recorded, not shown to the user)",
      banDuration: "For how long",
      banForever: "Until an administrator lifts it",
      unban: "Lift the suspension",
      delete: "Delete this account",
      deleteConfirm:
        "Deleting removes the account and everything attached to it. This cannot be undone.",
      revokeSessions: "Sign out everywhere",
      resetTwoFactor: "Reset two-factor authentication",
      sendReset: "Send a password-reset e-mail",
      temporaryPassword: "Set a temporary password",
      temporaryPasswordHelp:
        "They will have to choose a new one the next time they sign in.",
      setRoles: "Roles",
      setRolesHelp: "Tick the roles this account should hold.",
      editProfile: "Edit profile",
      emailVerifiedLabel: "E-mail address is confirmed",
      editProfileHelp:
        "The display name is built from the first and last name; it is not typed.",
      save: "Save",
      impersonate: "Sign in as this user",
      impersonateHelp:
        "Everything you do will be recorded against your own account.",
      // Still reachable: the endpoint refuses a POST that arrives while
      // impersonation is off, even though the control is no longer rendered.
      impersonateDisabled: "Impersonation is turned off on this server.",
      revokeKey: "Revoke",
      keyName: "Key name",
    },
    create: {
      title: "Create a user",
      description:
        "The account is created approved and confirmed — it is you doing the vouching.",
      email: "E-mail address",
      name: "Name",
      roles: "Roles",
      submit: "Create",
      passwordSent: "A link to choose a password has been e-mailed to them.",
      linkTitle: "Give them this link",
      linkHelp:
        "E-mail is turned off, so this is the only copy. It works once and expires.",
      // D65: which account, because two creations in a row otherwise produce
      // two links nobody can tell apart.
      linkFor: (email: string) =>
        `For ${email}. E-mail is turned off, so this is the only copy — it works once and expires.`,
    },
    clients: {
      title: "Applications",
      description:
        "Registered OAuth clients. Ones from oauth_clients.jsonc are reconciled at start-up and cannot be edited here; ones added here survive restarts and can.",
      empty: "No applications are registered.",
      managedFile: "From the file",
      managedDatabase: "Added here",
      managedBy: "Managed by",
      status: "Status",
      enabled: "Enabled",
      enable: "Enable",
      disable: "Disable",
      remove: "Remove",
      removeConfirm:
        "Removing the application revokes its tokens and disconnects everyone who allowed it. This cannot be undone.",
      add: "Add an application",
      addHelp:
        "The client secret is generated here and shown once. Redirect URIs are matched exactly.",
      clientId: "Client ID",
      name: "Name",
      type: "Type",
      typeWeb: "Web — a server-side app that can keep a secret",
      typeSpa: "Single-page app — no secret, PKCE required",
      typeNative: "Mobile or desktop app",
      onePerLine: "One per line. Matched exactly, so no wildcards.",
      secretTitle: "The client secret",
      secretHelp:
        "Copy it now — it is stored as a hash and cannot be shown again.",
      public: "Public",
      confidential: "Confidential",
      disabled: "Disabled",
      redirectUris: "Redirect URIs",
      scopes: "Scopes",
      // Round 3, finding 10: the column and the checkbox now both name the
      // thing being decided — does this application ask the user? — rather
      // than the `skipConsent` field stored underneath it.
      requireConsent: "Consent required",
      requireConsentLabel: "Require consent",
      requireConsentHelp:
        "The user is asked to approve the application the first time it asks for their data. Leave it off for applications you wrote yourself.",
      postLogoutRedirectUris: "Post-logout redirect URIs",
      enableEndSession: "Allow RP-initiated logout",
      enableEndSessionHelp:
        "Lets the application end the session here. Needs at least one post-logout redirect URI.",
      // What the form can decide for itself, before posting (D62). The same
      // rules the file schema applies, worded for the person typing rather
      // than for the operator reading a startup failure.
      invalidClientId:
        "Use letters, digits and `. _ ~ -` only — this is what the application sends at the token endpoint.",
      nameRequired: "Give the application a name; it is what users are asked to trust.",
      redirectRequired:
        "At least one redirect URI is required — every application here uses the authorization-code flow.",
      uriWildcard: (uri: string) =>
        `${uri} contains a wildcard. Redirect URIs are matched exactly, character for character.`,
      uriNotAbsolute: (uri: string) =>
        `${uri} is not an absolute URI. Include the scheme, as in https://app.example.com/callback.`,
      uriFragment: (uri: string) => `${uri} contains a "#" fragment, which is not allowed.`,
      uriHttp: (uri: string) =>
        `${uri} must use https. Plain http is only allowed on loopback — http://localhost or http://127.0.0.1.`,
      uriPrivateScheme: (uri: string) =>
        `${uri} uses a private-use scheme, which only a mobile or desktop application may do.`,
      endSessionNeedsUri:
        "RP-initiated logout needs at least one post-logout redirect URI. Add one, or turn the option off.",
    },
    roles: {
      title: "Roles",
      description:
        "The catalog from roles.jsonc. Roles are assigned per user; the catalog itself is edited in the file.",
      name: "Role",
      users: "Users",
      isDefault: "Given at sign-up",
      isAdmin: "Administrator",
      // FR-ADMIN-2 asks for it on *this* page. It sat under `clients` and
      // nothing rendered it.
      lastReconcile: "Last reconciled at start-up",
      warnings: "Roles held by users but missing from the catalog",
    },
    audit: {
      title: "Audit",
      description: "Every security-relevant event, newest first.",
      filterAction: "Event",
      filterOutcome: "Outcome",
      apply: "Filter",
      empty: "Nothing matches that.",
      more: "Older events",
      /** Prefixes the "What" cell for anything that is not a user. */
      targetType: (type: string) => `${type}:`,
      columns: {
        when: "When",
        action: "Event",
        outcome: "Outcome",
        actor: "Who",
        target: "What",
        details: "Details",
      },
    },
    system: {
      title: "System",
      version: "Version",
      revision: "Build",
      issuer: "Issuer",
      email: "E-mail",
      emailOn: (transport: string) => `On, via ${transport}`,
      emailOff: "Off — the server runs in degraded mode (FR-MAIL-2)",
      keys: "Signing keys",
      algorithm: "Algorithm",
      // "Signing key" over a `kid` read as though the key itself were on the
      // page (owner review round 2, finding 11). It never was: `/idp/system`
      // selects id, createdAt and expiresAt, and nothing reads `privateKey`.
      activeKey: "Active key ID",
      publishedKeys: "Published",
      rotate: "Rotate the signing key now",
      rotateHelp:
        "The new key is published first and starts signing an hour later, so tokens already issued keep verifying (FR-OIDC-16).",
      rotated: (keyId: string) => `A successor key was created: ${keyId}.`,
      startup: "Start-up",
      reconcile: "Client reconciliation",
      config: "Effective configuration",
      configHelp: "Secrets are masked.",
      warnings: "Warnings",
      discovery: "Discovery",
      discoveryHelp:
        "The URLs to give another system. All are served by this deployment unless noted.",
      discoveryUrls: {
        openidConfiguration: "OpenID Provider configuration",
        oauthAuthorizationServer: "OAuth authorization server metadata",
        // The two origin-root forms for an issuer with a path: RFC 8414 §3.1
        // defines the first, and enough clients ask for the second that
        // `Caddyfile.subpath` rewrites it too. Both sit above this app's mount
        // point, so the reverse proxy is what serves them.
        oauthAuthorizationServerRoot:
          "OAuth authorization server metadata (RFC 8414 root form — served by the reverse proxy)",
        openidConfigurationRoot:
          "OpenID Provider configuration (root form — served by the reverse proxy)",
        jwks: "JSON Web Key Set",
        // The URL is registered under RFC 8615; the behaviour is a W3C
        // change-password specification, which is what an operator recognises.
        changePassword: "Change-password well-known URL",
        securityTxt: "security.txt (RFC 9116)",
      },
    },
    refusals: {
      ownRoles: "You cannot change your own roles. Ask another administrator.",
      selfBan: "You cannot suspend your own account.",
      selfDelete: "You cannot delete your own account here.",
      selfImpersonate: "You are already signed in as yourself.",
      lastAdmin:
        "This is the only administrator left. Give another account an admin role first.",
      notAnAdmin: "Only an administrator can grant an admin role.",
      emailDisabled:
        "E-mail is turned off on this server, so nothing can be sent. Set a temporary password instead.",
      clientExists: "An application with that client ID is already registered.",
      clientFromFile:
        "That application comes from oauth_clients.jsonc. Edit the file and restart the server.",
      clientInvalid:
        "The application could not be registered. Check the redirect URIs and the scopes.",
    },
    notices: {
      approved: "Approved.",
      rejected: "Rejected.",
      banned: "Suspended.",
      unbanned: "The suspension has been lifted.",
      deleted: "The account has been deleted.",
      rolesSaved: "Roles updated.",
      sessionsRevoked: "Signed out everywhere.",
      twoFactorReset: "Two-factor authentication has been reset.",
      resetSent: "A password-reset e-mail has been sent.",
      temporaryPasswordSet:
        "A temporary password is set. They must change it at the next sign-in.",
      keyRevoked: "The API key has been revoked.",
      profileSaved: "Profile updated.",
      clientCreated: "The application has been registered.",
      clientDeleted: "The application has been removed.",
      clientDisabled: "The application has been disabled.",
      clientEnabled: "The application has been enabled.",
      created: "The account has been created.",
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
    twoFactorReset: {
      subject: (siteName: string) =>
        `Two-factor authentication was reset on your ${siteName} account`,
      heading: "An administrator reset your second factor",
      body: "Two-factor authentication is off, and you have been signed out everywhere. Sign in with your password and set it up again.",
      warning:
        "If you did not ask for this, contact your administrator immediately.",
      action: "Set up two-factor authentication",
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
