# Edunify backend

The REST API behind Edunify, a homework platform for schools. Teachers organise classes into lessons, set homework, and grade what students hand in, optionally with suggestions from an AI (Claude, Gemini or OpenAI; switched off for now with `AI_GRADING_ENABLED`). Students connect to their classes, submit text, code, drawings or photos, and see their grades.

Built with Node.js 24, Express 5, PostgreSQL 17 and Sequelize. Uploaded files are stored on local disk.

- [Running it locally](#running-it-locally)
- [How the API works](#how-the-api-works): base URL, sign-in, errors, limits, files
- [Data shapes](#data-shapes)
- [Endpoints](#endpoints)
- [A full example](#a-full-example): from an empty class to a grade
- [Deployment](docs/deploy.md), including the upgrade of a v1 server to v2
- [The contract](docs/contract.md) with the frontend, which wins wherever this file disagrees, and the [frontend tech spec](docs/techspec.md)

## Running it locally

You need Node.js 24 and PostgreSQL 17.

```sh
npm install
cp .env.example .env        # then fill in the values, see below
npm run migrate             # creates the tables in the database DATABASE_URL names
ADMIN_PASSWORD='at least 12 characters' npm run seed:admin   # the admin account, once
npm run dev                 # http://localhost:3000, restarts on file changes
```

The admin signs in at `POST /auth/admin/login` with the login `edunify_admin` (or `ADMIN_LOGIN`) and that password. Running `seed:admin` again changes nothing; `npm run seed:admin -- --reset-password` replaces the admin's password with `ADMIN_PASSWORD`.

`.env` holds:

| Variable | Meaning |
|---|---|
| `NODE_ENV` | `development`, `production` or `test` |
| `PORT` | HTTP port, default `3000` |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | at least 32 characters |
| `FILE_URL_SECRET` | at least 32 characters, different from the JWT secret |
| `STORAGE_DIR` | absolute path where uploaded files are kept |
| `AI_GRADING_ENABLED` | `true` turns AI grading on; default `false` (switched off for now): starting a job answers `503 AI_UNAVAILABLE` and no worker runs |
| `AI_PROVIDER_TEXT` | the AI that grades typed answers (`text`, `code`): `anthropic`, `gemini` or `openai`; default `anthropic` |
| `AI_PROVIDER_IMAGE` | the AI that grades pages (`draw`, `math`, `photo`); default `anthropic` |
| `AI_FALLBACK_PROVIDER` | optional; tried when the first AI fails (overloaded, out of quota, a bad answer) |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENAI_API_KEY` | optional; a provider without its key is off, and a homework type with no provider left answers `503 AI_UNAVAILABLE` |
| `ANTHROPIC_MODEL`, `GEMINI_MODEL`, `OPENAI_MODEL` | the model of each provider in use, for example `claude-opus-5-5`; required for every provider named above |

The server refuses to start if a value is missing or invalid, and says which.

### Tests

Tests run against a separate database whose name must end in `_test`. Put its URL in a git-ignored `.env.test`:

```sh
DATABASE_URL=postgres://postgres:change-me@localhost:5432/edunify_test
```

| Script | What it does |
|---|---|
| `npm run dev` | start the server with live reload |
| `npm test` | run all tests (migrates the test database first) |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint |
| `npm run build` | compile to `dist/` |
| `npm start` | run the compiled server (production; the host provides the variables) |
| `npm run migrate` / `migrate:down` / `migrate:status` | manage migrations on the `.env` database |
| `npm run seed:admin` | create the one admin account from `ADMIN_LOGIN` and `ADMIN_PASSWORD` (`seed:admin:prod` runs the compiled one) |

CI runs typecheck, lint, the tests and the build on every push to `main` and `dev` and on every pull request.

## How the API works

### Basics

- Every path starts with `/api/v1`. Requests and responses are JSON with `camelCase` keys, except the file uploads, which are `multipart/form-data`.
- A single resource comes back as itself, with no wrapper. Lists come back as `{ "items": [...] }`. There is no pagination except in the admin's user list; the [caps](#limits) keep the other lists small.
- `201` means created, `200` read or updated, `202` a job was started, and `204` (with an empty body) a delete or a mark-read.
- Ids are UUIDs. Times are ISO 8601 in UTC with milliseconds, like `2026-11-05T07:08:09.123Z`.
- Request bodies are strict: an unknown field is a `400 VALIDATION_ERROR`.
- Text is trimmed before it is checked, so `"  Maths "` is stored as `"Maths"`. Passwords and code answers (`html`, `css`, `js`) are the exception: they are checked and stored exactly as typed.
- Optional text that is empty after trimming (homework instructions, a grade comment) is stored as `null`.

### Who can call what

Each endpoint below lists who may call it:

| Mark | Meaning |
|---|---|
| Public | no sign-in |
| T | teachers only; everyone else gets `403 FORBIDDEN` |
| S | students only; everyone else gets `403 FORBIDDEN` |
| T, S | both, each seeing only their own; the admin gets `403 FORBIDDEN` |
| Any | any signed-in user, the admin included |
| AD | the admin only; everyone else gets `403 FORBIDDEN` |

Teachers only ever see their own classes. Students only see a class while they are **connected** to it, which takes two steps in either order:

1. The teacher adds the student to the class roster with the student's ID (`studentPublicId`).
2. The student enters the class ID (`classPublicId`) through `POST /student/claims`.

Asking for something you don't own or aren't connected to gives the same `404 NOT_FOUND` as asking for something that doesn't exist, so the API never reveals whether it exists.

### Signing in and staying signed in

1. `POST /auth/register`, `POST /auth/login` (or `POST /auth/admin/login` for the admin) returns `{ user, accessToken }` and sets the refresh cookie `edunify_rt`. The cookie is `HttpOnly`, `SameSite=Strict`, sent only to `/api/v1/auth`, lasts 30 days, and is `Secure` in production.
2. Send the access token on every other call: `Authorization: Bearer <accessToken>`. It lasts 15 minutes. Keep it in memory only, never in `localStorage`.
3. When a call answers `401` with code `TOKEN_EXPIRED`, call `POST /auth/refresh` once (the browser sends the cookie), then repeat the call with the new token. Browsers need `withCredentials: true` (or `credentials: 'include'`) for the cookie to travel.
4. Any other `401` means the session is over: show the sign-in page.
5. On app start, call `POST /auth/refresh`. A `401` means nobody is signed in.

Every refresh replaces the refresh token with a new one. If several tabs refresh with the same token within 10 seconds of each other, each of them gets a fresh access token, but no new cookie. Using an old refresh token after that, or after sign-out, ends that session everywhere (`401 UNAUTHENTICATED`).

#### Account status

The server reads the account on every call, so these take effect at once, even for an access token already handed out. It checks them in this order, before anything else:

1. **Blocked** by the admin: every call answers `403 ACCOUNT_BLOCKED`, `/me` and `POST /auth/refresh` included. Sign the user out and say the account is blocked.
2. **Password reset** by the admin (`user.mustChangePassword` is `true`): every call but `/me` and `/me/password` answers `403 PASSWORD_CHANGE_REQUIRED`. Show the "Set new password" screen; `POST /me/password` clears it.
3. **Pending** (a new teacher, `user.status` is `pending`): every call but `/me` and `/me/password` answers `403 ACCOUNT_PENDING`. Show "Waiting for Edunify admin approval" and poll `GET /me` every 30 seconds until `status` is `active`.

The admin changes these through the [admin endpoints](#admin-the-admin-only): approving, rejecting, blocking and unblocking accounts, and issuing a temporary password to someone who forgot theirs.

Students start `active`. Nothing is ever sent by email or SMS: there is no email check and no self-service password reset.

### Errors

Every error has this shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "Invalid request", "details": [ { "path": "fullName", "message": "Required" } ] } }
```

Show text based on `code`; `message` is English for logs. `details` lists each problem with its field path, and comes only with `VALIDATION_ERROR` and `AI_JOB_ACTIVE`.

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Invalid body, query, path or upload content |
| `UNAUTHENTICATED` | 401 | Missing, invalid or revoked credentials |
| `TOKEN_EXPIRED` | 401 | Access token expired: refresh and retry |
| `INVALID_CREDENTIALS` | 401 | Wrong email, login, password, or current password, or the wrong `role` at sign-in |
| `FORBIDDEN` | 403 | This role may not use the endpoint |
| `ACCOUNT_PENDING` | 403 | The teacher account is waiting for the admin's approval |
| `ACCOUNT_BLOCKED` | 403 | The admin blocked this account |
| `PASSWORD_CHANGE_REQUIRED` | 403 | The admin reset the password; change it with `POST /me/password` first |
| `FILE_URL_INVALID` | 403 | The signed file URL is invalid or has expired |
| `NOT_FOUND` | 404 | Doesn't exist, or you can't see it |
| `STUDENT_ID_NOT_FOUND` | 404 | No student has that ID |
| `CLASS_ID_NOT_FOUND` | 404 | No class has that ID |
| `EMAIL_TAKEN` | 409 | The email is already registered |
| `CATEGORY_NAME_TAKEN` | 409 | You already have a category with this name (case doesn't matter) |
| `CATEGORY_NOT_EMPTY` | 409 | The category still has classes |
| `LAST_UNIT` | 409 | A class must keep at least one unit; `details.classIds` names the classes (every class of a group) |
| `INVALID_STATUS_TRANSITION` | 409 | That account status change isn't allowed (see the admin endpoints) |
| `STUDENT_ID_IN_USE` | 409 | That student already has a row in this class |
| `HOMEWORK_TYPE_LOCKED` | 409 | The homework type can't change once there are submissions (in any class that holds the lesson) |
| `CLASS_IN_OTHER_GROUP` | 409 | A class in `linkedClassIds` is already in another group |
| `UNIT_NOT_EMPTY` | 409 | A unit of a group can only be deleted when no class has a lesson in it |
| `SUBMISSION_NOT_LATEST` | 409 | Only the latest version of a submission can be graded |
| `AI_JOB_ACTIVE` | 409 | AI grading is already running for this lesson; `details.jobId` names the job |
| `LIMIT_REACHED` | 409 | A cap was hit (see below); for a class in a group, `details.classIds` names the classes over it |
| `PAYLOAD_TOO_LARGE` | 413 | Body or file too large |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | File type not allowed |
| `RATE_LIMITED` | 429 | Too many requests; wait the number of seconds in `Retry-After` |
| `INTERNAL` | 500 | Unexpected server error |
| `AI_UNAVAILABLE` | 503 | AI grading is not configured on this server |

### Limits

| Rate limit | Allowed |
|---|---|
| `POST /auth/login` | 10 per 15 minutes per IP and email |
| Failed `POST /auth/login` | 100 per 15 minutes per IP, whatever the email; successful sign-ins don't count |
| `POST /auth/admin/login` | 5 per 15 minutes per IP |
| `POST /auth/register` | 10 per hour per IP |
| Looking up an ID (`POST /student/claims`, adding or changing a roster row with `studentPublicId`) | 30 per 10 minutes per user |
| `POST /lessons/:lessonId/ai-grade` | 5 per minute per user |
| Everything else | 300 per minute per user (per IP when signed out) |

| Cap | Maximum |
|---|---|
| Categories per teacher | 100 |
| Classes per teacher | 100 |
| Students per class | 200 |
| Units per class | 100 |
| Lessons per class | 500 |
| Pages per submission | 9 |
| Versions per student per homework | 30 |
| Classes per group | 10 |

Units and lessons per class include the group's units and linked lessons. If adding or linking something would take any class of a group past a cap, nothing changes and `LIMIT_REACHED` lists those classes in `details.classIds`.

| Field | Rule |
|---|---|
| `email` | valid email, up to 254 characters, stored in lowercase |
| `password` | 8 to 128 characters |
| `confirmPassword`, `confirmNewPassword` | the same as `password` / `newPassword` |
| `firstName`, `lastName` | 1 to 50 each |
| `phone` (teachers) | spaces, dashes and brackets are removed, then `+` and 8 to 15 digits, like `+998901234567`; stored that way |
| Admin `login` | 3 to 40 of `a-z`, `0-9` and `_`, case ignored |
| `fullName` (roster row) | 1 to 100 |
| Category `name` | 1 to 60 |
| Class `name` | 1 to 80 |
| Unit or lesson `title` | 1 to 120 |
| Homework `instructionsText` | up to 10,000 |
| Text submission | 1 to 20,000 |
| Code submission `html`, `css`, `js` | up to 100,000 each, at least one not empty |
| Grade `comment` | up to 2,000 (1 to 2,000 when denying) |
| JSON body | 1 MB |

### Public IDs

Students and classes each have an 8-character public ID made of `a-z` and `0-9`. Show it as `#XXXX-XXXX`. The API accepts it typed any way: it trims, lowercases, and drops `#` and `-` before checking. A student's ID is only ever shown to that student; a class's ID only to its teacher.

### Files

Files come back as a `FileRef` whose `url` is a signed link, valid for at least 15 minutes, until `expiresAt`. A file's `url` stays the same for every response within the same 5 minutes, so the browser can show it from its cache instead of downloading it again. Use it directly in `<img>`, `<iframe>` or `fetch`: it needs no `Authorization` header. If it answers `403 FILE_URL_INVALID`, the link has expired: reload whatever gave you the `FileRef` to get a fresh one.

| Upload | Types | Largest |
|---|---|---|
| Lesson file, homework instructions file (field `file`) | `.md` (valid UTF-8), `.pdf` | 1 MB / 20 MB |
| Draw or math pages (field `pages`) | `.png` | 10 MB each |
| Photo pages (field `pages`) | `.jpg`, `.jpeg`, `.png`, `.webp` | 10 MB each |

The type is checked by the file's extension and its content, not by the MIME type the client sends. Markdown files are served back as `text/plain; charset=utf-8`.

## Data shapes

```ts
type Role = 'teacher' | 'student' | 'admin'
type UserStatus = 'pending' | 'active' | 'blocked'
type HomeworkType = 'text' | 'draw' | 'math' | 'code' | 'photo'   // math works exactly like draw
type SubmissionStatus = 'submitted' | 'denied' | 'graded'
type CellStatus = 'empty' | 'submitted' | 'denied' | 'graded'    // 'empty' = nothing handed in yet
type ConnectionState = 'not_connected' | 'awaiting_student' | 'connected'
type NotificationKind = 'graded' | 'denied'   // students only
type JobStatus = 'queued' | 'running' | 'done' | 'failed'
type Grade = 2 | 3 | 4 | 5

interface User {
  id: string
  role: Role
  firstName: string
  lastName: string
  email: string | null         // teachers and students; null for the admin
  phone: string | null         // teachers only, like +998901234567
  login: string | null         // the admin only
  publicId: string | null      // students only
  status: UserStatus           // teachers start pending
  mustChangePassword: boolean  // true after an admin password reset
  createdAt: string
}

interface FileRef {
  id: string
  name: string                 // the original file name
  mime: string
  size: number                 // bytes
  url: string                  // signed, valid at least 15 minutes
  expiresAt: string
}

interface Category { id: string; name: string; order: number; classCount: number; createdAt: string }

interface Class {
  id: string
  categoryId: string
  order: number                // 0-based within its category
  name: string
  publicId: string             // show as #XXXX-XXXX
  studentCount: number
  newSubmissionCount: number   // homework waiting for a grade: one per student whose latest version is 'submitted', over every lesson of the class (hidden ones too)
  linkedClasses: { id: string; name: string }[]   // the other classes of its group, by name; [] when it is in none
  createdAt: string
}

interface ClassStudent {
  id: string
  fullName: string                 // the name on the teacher's roster
  studentPublicId: string | null   // the student's ID the teacher entered, or null
  connectionState: ConnectionState // not_connected, awaiting_student (no claim yet), connected
}

interface Unit { id: string; classId: string; title: string; order: number }   // order: 0-based in the class

interface LessonSummary {
  id: string
  unitId: string                       // every lesson is in a unit
  number: number                       // 1, 2, 3... across units in outline order; computed, never stored
  title: string
  order: number                        // 0-based within its unit in this class
  homeworkType: HomeworkType | null    // null = no homework
  linked?: boolean                     // teachers only; true for a lesson shared by the class group
  visible?: boolean                    // teachers only; students only ever get visible lessons
  newSubmissionCount?: number          // teachers only: the same count for this lesson in this class; 0 without homework
}

interface Homework {
  id: string
  lessonId: string
  type: HomeworkType
  instructionsText: string | null
  instructionsFile: FileRef | null
}

interface LessonDetail {
  id: string
  classId: string                      // the class it was asked for in
  unitId: string
  number: number
  title: string
  order: number
  lessonFile: FileRef | null
  homework: Homework | null
  linked?: boolean                     // teachers only
  visible?: boolean                    // teachers only
  mySubmission?: Submission | null     // students only: their latest version
}

interface ContentImpact { classes: { id: string; name: string; submissionCount: number }[] }   // every class holding it, this one included

interface GroupPreviewItem {
  classId: string
  name: string
  addedUnits: number           // what a class gets when the save goes through: units...
  addedLessons: number         // ...and linked lessons (hidden at first)
  convertedUnits: number       // what turns into class-only copies in a class that leaves, or is left alone
  convertedLessons: number
}

type SubmissionContent =
  | { type: 'text'; text: string }
  | { type: 'code'; html: string; css: string; js: string }
  | { type: 'draw' | 'math' | 'photo'; pages: FileRef[] }   // 1 to 9 pages, in order

interface GradeInfo {
  value: Grade | null          // null when denied
  denied: boolean
  comment: string | null
  source: 'teacher' | 'ai_confirmed'
  gradedAt: string
}

interface AiSuggestion { value: Grade; comment: string; createdAt: string }

interface Submission {
  id: string
  homeworkId: string
  lessonId: string
  classId: string
  classStudentId: string
  version: number              // 1, 2, 3...
  isLatest: boolean
  status: SubmissionStatus
  content: SubmissionContent
  grade: GradeInfo | null
  aiSuggestion?: AiSuggestion | null   // in teacher responses only; students never get it
  createdAt: string
  updatedAt: string
}

interface SubmissionVersion {
  id: string
  version: number
  status: SubmissionStatus
  grade: { value: Grade | null; denied: boolean } | null
  createdAt: string
}

interface JournalCell { lessonId: string; status: CellStatus; value: Grade | null; submissionId: string | null }

interface AiJob {
  id: string
  lessonId: string
  classId: string
  status: JobStatus
  total: number
  completed: number            // suggestions made
  failed: number               // submissions that couldn't be graded
  error: string | null         // set only when the whole job failed
  createdAt: string
  finishedAt: string | null
}

interface NotificationItem {
  id: string
  kind: NotificationKind
  submissionId: string
  lessonId: string
  classId: string
  lessonTitle: string
  className: string
  createdAt: string
}
```

## Endpoints

All paths below start with `/api/v1`.

### Health and sign-in

| Endpoint | Who | What it does |
|---|---|---|
| `GET /health` | Public | Answers `200 { "status": "ok" }` when the server is up. |
| `POST /auth/register` | Public | Creates an account and signs it in. Teacher body `{ role: 'teacher', firstName, lastName, phone, email, password, confirmPassword }`; student body the same without `phone`. Returns `201 { user, accessToken }` and sets the refresh cookie. A teacher comes back `pending`; a student `active`, with a `publicId`. Errors: `EMAIL_TAKEN`, `VALIDATION_ERROR` (also for `role: 'admin'`). |
| `POST /auth/login` | Public | Signs in a teacher or student. Body `{ role, email, password }`; a `role` that isn't the account's answers like a wrong password. Returns `200 { user, accessToken }` and sets the refresh cookie. A pending teacher can sign in. Errors: `INVALID_CREDENTIALS`, `ACCOUNT_BLOCKED` (only after the right password). |
| `POST /auth/admin/login` | Public | Signs in the admin. Body `{ login, password }`. Returns `200 { user, accessToken }` and sets the refresh cookie. Error: `INVALID_CREDENTIALS`. |
| `POST /auth/refresh` | Cookie | Swaps the refresh cookie for a new access token. No body. Returns `200 { user, accessToken }` and a new cookie. Errors: `UNAUTHENTICATED`, `ACCOUNT_BLOCKED`. |
| `POST /auth/logout` | Cookie | Signs out: ends the cookie's session and clears the cookie. No body. Returns `204`, also when there is no cookie. |
| `GET /me` | Any | Returns `200 User`. Works while pending or after a password reset. |
| `PATCH /me` | Any | Changes your profile. Body `{ firstName?, lastName?, phone? }`; only teachers have a `phone`. Returns `200 User`. |
| `POST /me/password` | Any | Changes your password. Body `{ currentPassword, newPassword, confirmNewPassword }`. Returns `204` with a fresh refresh cookie for you, signs out every other session, and clears `mustChangePassword`. Errors: `INVALID_CREDENTIALS` (wrong current password), `VALIDATION_ERROR`. |

### Categories (teachers)

Categories group a teacher's classes.

| Endpoint | What it does |
|---|---|
| `GET /categories` | Your categories, sorted by `order`. `200 { items: Category[] }` |
| `POST /categories` | Body `{ name }`. Adds it last. `201 Category`. Errors: `CATEGORY_NAME_TAKEN`, `LIMIT_REACHED`. |
| `PATCH /categories/:id` | Body `{ name?, order? }`: renames it, and/or moves it to the 0-based position `order` among your categories (the others shift to make room). `200 Category`. Errors: `CATEGORY_NAME_TAKEN`, `VALIDATION_ERROR` for an `order` past the last category. |
| `DELETE /categories/:id` | `204`; the categories after it move up one. Error: `CATEGORY_NOT_EMPTY` while it still has classes. |

### Classes (teachers)

| Endpoint | What it does |
|---|---|
| `GET /classes?categoryId=` | Your classes in category order, then class `order`; `categoryId` is an optional filter. `200 { items: Class[] }` |
| `POST /classes` | Body `{ categoryId, name }`. Adds it last in its category, with its first unit, `Unit 1`. `201 Class`, with its generated `publicId` to give to students. Errors: `LIMIT_REACHED`, `VALIDATION_ERROR` for a category that isn't yours. |
| `GET /classes/:id` | `200 Class` |
| `PATCH /classes/:id` | Body `{ categoryId?, name?, order?, linkedClassIds? }`. `order` is the 0-based position in the category the class ends up in: the new one when `categoryId` changes, else its own. Moving to another category without `order` puts it last there. Send both on every drag and drop. `linkedClassIds` sets the class's group (see below). `200 Class`. Errors: `VALIDATION_ERROR` for an `order` past the end or a category that isn't yours, `CLASS_IN_OTHER_GROUP`, `LIMIT_REACHED`, `NOT_FOUND` for a linked class that isn't yours. |
| `POST /classes/:id/linked-classes/preview` | Body `{ linkedClassIds }`. What saving that list would do, without doing it: `200 { items: GroupPreviewItem[] }`, one per class that changes (this class first, then the listed ones in order, then the rest by name); empty when nothing would. Same errors as the save. Show it before the save. |
| `DELETE /classes/:id` | Deletes the class with everything in it: roster, lessons, homework, submissions, grades and files. In a group it leaves first: linked lessons only it held go, the others stay with the group, and a group left with one class is dissolved. The classes after it move up one. `204` |

#### Class groups

Two to ten of your classes, in any categories, can share units and lessons. `linkedClassIds` on `PATCH /classes/:id` is the whole list of *other* classes in the group after the save (0 to 9 ids, not the class itself): leave it out to change nothing, send `[]` to take this class out of its group.

- **Making or joining a group.** Every class in a group holds every unit of the group, in the same order. When a group is made, the class you save goes first: its units, then each listed class's units in list order. A class joining an existing group gets the group's units first, then its own at the end (the other classes get its units at the end too), and every linked lesson of the group, **hidden** from its students until you show it. A class's own lessons stay its own and keep their places.
- **Leaving.** A class that leaves keeps everything it holds as its own copies: the units and the linked lessons, with their homework and files, in the same places, with the same visibility. Its students' submissions and grades move to the copies. A group left with one class is dissolved, and that class gets copies the same way.
- A class already in another group can't be listed (`CLASS_IN_OTHER_GROUP`). Nothing changes when a save fails.

In a group, units are always shared: adding, renaming or moving a unit does it in every class, and deleting one works only when no class has a lesson in it (`UNIT_NOT_EMPTY`). Lessons are either **class-only** (in one class, the default) or **linked** (shared by the group). Editing a linked lesson's title, file or homework changes it in every class; whether students see it, the student work, grades, journal, AI jobs and counts stay per class.

### Class roster (teachers)

Each row is one student in the class, with the name the teacher knows them by. A row keeps its submissions and grades even if the student's account changes.

| Endpoint | What it does |
|---|---|
| `GET /classes/:classId/students` | The roster, sorted by name, each row with its `connectionState`. `200 { items: ClassStudent[] }` |
| `POST /classes/:classId/students` | Adds a row. Body `{ fullName, studentPublicId? }`. `201 ClassStudent`. Errors: `STUDENT_ID_NOT_FOUND`, `STUDENT_ID_IN_USE`, `LIMIT_REACHED`. |
| `PATCH /classes/:classId/students/:id` | Body `{ fullName?, studentPublicId? }`. A new `studentPublicId` moves the row to another account, for a student who lost theirs; the old account loses access at once. `studentPublicId: null` disconnects the row. `200 ClassStudent`. Same errors as adding. |
| `DELETE /classes/:classId/students/:id` | Deletes the row with its submissions and grades. `204` |

### Student side (students)

| Endpoint | What it does |
|---|---|
| `POST /student/claims` | Enters a class ID. Body `{ classPublicId }`. Returns `200 { "saved": true }` for any existing class, whether or not the teacher has added you yet, and doing it twice is harmless. Error: `CLASS_ID_NOT_FOUND`. |
| `GET /student/classes` | Classes you are connected to, sorted by name. `200 { items: [{ id, name, teacherName, classStudentId }] }` |

### Outline, units and lessons

Every lesson sits in a unit, and a class always keeps at least one unit (a new class starts with `Unit 1`). `order` is the 0-based position among siblings; the server keeps positions continuous when you add, move or delete. Each lesson also has a `number`, 1, 2, 3... running across units in outline order. Numbers are computed on every read, so any change renumbers the lessons after it; you never send one.

A teacher can hide a lesson from students (`visible: false`, per class). Hidden lessons keep their number, so students can see gaps (1, 2, 4). A student never gets a hidden lesson, or a unit with nothing visible in it.

**`?classId=` is required** on every route below that names a unit, lesson or homework by id, and on grading, AI grading and handing in. It says which class the request is about. A class you don't own or aren't connected to, an item that class doesn't hold, or (for students) a hidden lesson all answer `404 NOT_FOUND`.

| Endpoint | Who | What it does |
|---|---|---|
| `GET /classes/:classId/outline` | T, S | The class's structure: `200 { units: Unit[], lessons: LessonSummary[] }`. Units in order; lessons in outline order (unit order, then lesson order), each with its `number`. |
| `POST /classes/:classId/units` | T | Body `{ title }`. Adds it at the end (in a group, at the end in every class). `201 Unit`. Error: `LIMIT_REACHED`. |
| `PATCH /units/:id?classId=` | T | Body `{ title?, order? }`; `order` moves it to that position. In a group both change in every class. `200 Unit`. An `order` out of range is a `VALIDATION_ERROR`. |
| `DELETE /units/:id?classId=` | T | Outside a group: deletes the unit with its lessons, their homework and submissions. In a group: deletes it from every class, only when no class has a lesson in it. `204`. Errors: `LAST_UNIT` for the only unit, `UNIT_NOT_EMPTY`. |
| `POST /classes/:classId/lessons` | T | Body `{ title, unitId, linked? }`. Adds it visible, at the end of its unit. `linked: true` (only in a group) shares it: every other class of the group gets it too, hidden. `201 LessonDetail`. Errors: `LIMIT_REACHED`, `VALIDATION_ERROR` for a unit of another class or `linked: true` outside a group. |
| `GET /lessons/:id?classId=` | T, S | `200 LessonDetail`. Students also get `mySubmission`: their latest version, or `null`. |
| `PATCH /lessons/:id?classId=` | T | Body `{ title?, unitId?, order?, visible?, linked? }`. `order` is the position in the unit the lesson ends up in (the new one when `unitId` changes); moving to another unit without `order` puts it last there. Send both on every drag and drop. `visible` hides or shows it in this class only. A linked lesson moves in every class: it goes right after the linked lesson before it in this class's list, so a class-only lesson can keep the spot you aimed for and the moved one lands just after it; reload the outline after a move. `linked: true` shares a class-only lesson where it is (the other classes get it hidden); `linked: false` replaces a linked lesson in this class with a class-only copy in the same place, with this class's work, so the response has a **new `id`**. `200 LessonDetail`. Errors: `LIMIT_REACHED`, `VALIDATION_ERROR` for `linked: true` outside a group. |
| `DELETE /lessons/:id?classId=&scope=` | T | `scope=class` (the default) takes the lesson out of this class with this class's submissions; a class-only lesson is deleted, and so is a linked one that no class holds any more. `scope=all` (linked lessons only) deletes it with its submissions in every class. `204`. A `scope=all` on a class-only lesson is a `VALIDATION_ERROR`. |
| `GET /lessons/:id/impact?classId=` | T | Which classes hold the lesson and how many of their students handed it in: `200 ContentImpact`. Show it before a delete. |

### Lesson file and homework (teachers)

Each lesson can have one file to read and one piece of homework. Uploads are `multipart/form-data` with the file in the field `file`. Every path here takes `?classId=`. On a linked lesson every change here reaches every class that holds it. Copies made when a class leaves its group share their files with the original; a file is deleted only once no lesson or homework uses it.

| Endpoint | What it does |
|---|---|
| `PUT /lessons/:id/lesson-file` | Uploads or replaces the lesson's file (`.md` or `.pdf`). `200 LessonDetail` |
| `DELETE /lessons/:id/lesson-file` | Removes it. `200 LessonDetail` |
| `PUT /lessons/:id/homework` | Creates or replaces the homework. Body `{ type, instructionsText? }`; leaving `instructionsText` out clears it, and an instructions file stays. `200 LessonDetail`. Error: `HOMEWORK_TYPE_LOCKED` when changing the type after students in any class holding the lesson have submitted. |
| `DELETE /lessons/:id/homework` | Deletes the homework with all its submissions and grades, in every class that holds the lesson (`GET /lessons/:id/impact` has the counts). `200 LessonDetail` |
| `PUT /lessons/:id/homework/file` | Uploads or replaces an instructions file (`.md` or `.pdf`). Needs homework first. `200 LessonDetail` |
| `DELETE /lessons/:id/homework/file` | Removes it. `200 LessonDetail` |

### Submissions

Each hand-in is a new version; earlier versions and their grades stay.

| Endpoint | Who | What it does |
|---|---|---|
| `POST /homeworks/:homeworkId/submissions?classId=` | S | Hands in the homework. The body depends on the homework type: **text** JSON `{ text }`; **code** JSON `{ html, css, js }`; **draw**, **math**, **photo** `multipart/form-data` with 1 to 9 files in the repeated field `pages`, in page order. Code is stored exactly as typed: each field may be up to 100 000 characters as sent, and at least one must have something other than spaces. Returns `201 Submission` with the next version number; the teacher sees it in `newSubmissionCount`. Errors: `VALIDATION_ERROR` (content doesn't fit the type), `LIMIT_REACHED` (30 versions, or a 10th page), `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, and `NOT_FOUND` when you aren't connected to the class or the lesson is hidden. |
| `GET /student/submissions?classId=` | S | Your latest version of each homework, newest first; `classId` is an optional filter. Hidden lessons are left out. `200 { items: [{ submission, lesson: { id, title }, class: { id, name } }] }` |
| `GET /submissions/:id` | T, S | One version, with the list of all versions of that homework by that student, newest first. `200 Submission & { versions: SubmissionVersion[] }`. A student gets `404` while the lesson is hidden; the teacher still sees it. |

### Grading (teachers)

| Endpoint | What it does |
|---|---|
| `GET /lessons/:lessonId/grading?classId=` | Everything to grade one lesson in one class: `200 { lesson: { id, title }, homework: Homework, items: [{ classStudentId, fullName, submission }] }`. One item per roster row of that class, sorted by name; hidden lessons can be graded too; `submission` is that student's latest version, with any AI suggestion, or `null`. `404` if the lesson has no homework. |
| `PUT /submissions/:id/grade` | Grades the latest version: `{ value: 2-5, comment?, fromAi? }`, or sends it back: `{ denied: true, comment }`. A second call replaces the grade. `fromAi: true` confirms the AI suggestion (you may change its value or comment) and marks the grade `ai_confirmed`. Returns `200 Submission` and notifies the student. Errors: `SUBMISSION_NOT_LATEST`, and `VALIDATION_ERROR` for both or neither of `value` and `denied`, a denial without a comment, or `fromAi` with no suggestion. |
| `DELETE /submissions/:id/grade` | Removes the grade: the submission goes back to `submitted`, and the student's unread notification for it disappears. `200 Submission`. Error: `SUBMISSION_NOT_LATEST`. |

### Journal and grades

Both show only lessons that have homework, as columns in outline order with their `number`, and one cell per lesson from the latest version. The teacher's journal includes hidden lessons; a student's grades leave them out. `average` is the mean of the graded cells it shows, to 2 decimal places; denied and empty cells don't count, nor do grades on lessons hidden from the student, and it is `null` when nothing is graded.

| Endpoint | Who | What it does |
|---|---|---|
| `GET /classes/:classId/journal` | T | The whole class: `200 { units: Unit[], columns: [{ lessonId, number, title, unitId }], rows: [{ classStudentId, fullName, connectionState, cells: JournalCell[], average }] }`. Rows are sorted by name; `cells` line up with `columns`. |
| `GET /student/grades` | S | Your own grades, one item per class: `200 { items: [{ class: { id, name }, columns, cells, average }] }`, sorted by class name |

### AI grading (teachers)

An AI reads the lesson's Markdown file, the homework instructions and the student's work, and suggests a grade and a comment. It never grades on its own: the suggestion is shown only to the teacher, who confirms it with `PUT /submissions/:id/grade` and `fromAi: true`. PDFs are not sent to the AI.

**AI grading is switched off for now** (`AI_GRADING_ENABLED` is `false` by default). While it is off, `POST /lessons/:lessonId/ai-grade` answers `503 AI_UNAVAILABLE`, no job runs, and jobs left unfinished are closed as `failed` when the server starts. Suggestions made earlier can still be confirmed.

Which AI grades depends on the homework type and the server's settings: typed answers (`text`, `code`) go to `AI_PROVIDER_TEXT`, pages (`draw`, `math`, `photo`) to `AI_PROVIDER_IMAGE`, each one Claude, Gemini or OpenAI. If that AI fails, `AI_FALLBACK_PROVIDER` gets the same request. Every AI gets the same instructions and its answer goes through the same checks, so the API behaves the same whichever graded. Page images are scaled down for the AI only (at most 2576 px on the long edge, and smaller when a submission has many large pages); the stored page the teacher sees is unchanged.

| Endpoint | What it does |
|---|---|
| `POST /lessons/:lessonId/ai-grade?classId=` | Starts a job for that class's students. Body `{ submissionIds? }`: leave it out for every latest submission still waiting for a grade, or list specific ones (`[id]` for one student). Returns `202 AiJob`. Errors: `AI_JOB_ACTIVE` (one job per lesson and class; `details.jobId` names it), `VALIDATION_ERROR` (ids that aren't latest versions in this lesson, or nothing to grade), `AI_UNAVAILABLE`, `RATE_LIMITED` (5 a minute). |
| `GET /ai-jobs/:id` | The job's progress: `200 AiJob`. Poll it every 2 seconds while `status` is `queued` or `running`; when it turns `done` or `failed`, reload the grading page. `done` means every submission was processed, some perhaps in `failed`; `failed` means the job itself couldn't run, with the reason in `error`. |

### Notifications (students)

Students get `graded` or `denied` when the teacher grades or sends back their work. There is at most one notification per student and submission: a new event on the same submission updates it and makes it unread again, and removing the grade takes back an unread one. A student only sees notifications for classes they are connected to now (after a reconnect the old account loses them) and for lessons the class shows.

Teachers have no notifications and get `403 FORBIDDEN` here, like the admin. They see `newSubmissionCount` on each class (`GET /classes`) and on each lesson in the outline instead: it goes up when a student hands in a new version or a grade is removed, and down when the teacher grades or sends it back. Poll it every 45 seconds.

| Endpoint | What it does |
|---|---|
| `GET /notifications/count` | `200 { unreadCount }`, cheap enough to poll. |
| `GET /notifications` | Unread notifications, newest first, at most 100. `200 { items: NotificationItem[] }` |
| `POST /notifications/:id/read` | Marks one read. No body. `204`, also if it was already read. Mark it read when the student opens the homework. |

### Files

| Endpoint | Who | What it does |
|---|---|---|
| `GET /files/:id?exp=&sig=` | Signed URL | The file's bytes, with the right `Content-Type`. Use the `url` from a `FileRef` as it is. Errors: `FILE_URL_INVALID` (expired or altered link), `NOT_FOUND` (the file was removed). |

### Admin (the admin only)

The admin sees accounts only, never classes, lessons or students' work. Every endpoint here works on teachers and students; the admin's own id answers `404 NOT_FOUND`, like an id that doesn't exist.

| Endpoint | What it does |
|---|---|
| `GET /admin/users?role=&status=&q=&limit=&offset=` | Teachers and students, newest first: `200 { items: User[], total }`. All filters are optional: `role` is `teacher` or `student`; `status` is `pending`, `active` or `blocked`; `q` finds text in the first name, last name, whole name, email or phone, ignoring case (a phone matches however it is typed, with spaces or brackets). `limit` is 1 to 100 (default 50), `offset` 0 or more (default 0); `total` counts every match. A student's `publicId` is always `null` here. |
| `PATCH /admin/users/:id/status` | Body `{ status }`, `active` or `blocked`. Allowed: `pending` to `active` (approve) or `blocked` (reject), `active` to `blocked`, `blocked` to `active`. Blocking signs the user out everywhere at once. Returns `200 User`. Error: `INVALID_STATUS_TRANSITION` for anything else, the same status included. |
| `POST /admin/users/:id/reset-password` | No body. Returns `200 { temporaryPassword }`: 12 characters without look-alikes (no `0 O 1 l I`). It is shown only this once and never stored, so show it with a Copy button. The user is signed out everywhere, signs in with it, and must choose a new password (`POST /me/password`) before anything else works. |

## A full example

From an empty class to a grade, with `curl` against a local server. `jq` pulls fields out of the responses.

```sh
API=http://localhost:3000/api/v1
JSON='Content-Type: application/json'

# A teacher signs up. The access token goes in a variable, the refresh cookie in a cookie jar.
TEACHER=$(curl -s -c teacher.jar -X POST $API/auth/register -H "$JSON" \
  -d '{"role":"teacher","firstName":"Teacher","lastName":"One","phone":"+998901234567","email":"teacher@example.com","password":"long-password-1","confirmPassword":"long-password-1"}')
T=$(echo "$TEACHER" | jq -r .accessToken)

# The teacher is pending until the admin approves. (The admin was made with npm run seed:admin.)
A=$(curl -s -X POST $API/auth/admin/login -H "$JSON" \
  -d '{"login":"edunify_admin","password":"the-admin-password"}' | jq -r .accessToken)
curl -s -X PATCH $API/admin/users/$(echo "$TEACHER" | jq -r .user.id)/status \
  -H "Authorization: Bearer $A" -H "$JSON" -d '{"status":"active"}'

# A student signs up and gets a public ID to give the teacher.
STUDENT=$(curl -s -X POST $API/auth/register -H "$JSON" \
  -d '{"role":"student","firstName":"Student","lastName":"One","email":"student@example.com","password":"long-password-2","confirmPassword":"long-password-2"}')
S=$(echo "$STUDENT" | jq -r .accessToken)
STUDENT_ID=$(echo "$STUDENT" | jq -r .user.publicId)

# The teacher makes a category and a class, and adds the student by ID.
CATEGORY=$(curl -s -X POST $API/categories -H "Authorization: Bearer $T" -H "$JSON" -d '{"name":"Mathematics"}' | jq -r .id)
CLASS=$(curl -s -X POST $API/classes -H "Authorization: Bearer $T" -H "$JSON" \
  -d "{\"categoryId\":\"$CATEGORY\",\"name\":\"Algebra 7A\"}")
CLASS_ID=$(echo "$CLASS" | jq -r .id)
CLASS_PUBLIC_ID=$(echo "$CLASS" | jq -r .publicId)
curl -s -X POST $API/classes/$CLASS_ID/students -H "Authorization: Bearer $T" -H "$JSON" \
  -d "{\"fullName\":\"Ali Valiyev\",\"studentPublicId\":\"$STUDENT_ID\"}"      # connectionState: awaiting_student

# The student enters the class ID: now they are connected.
curl -s -X POST $API/student/claims -H "Authorization: Bearer $S" -H "$JSON" -d "{\"classPublicId\":\"$CLASS_PUBLIC_ID\"}"

# The teacher adds a lesson with text homework, in the class's first unit.
UNIT=$(curl -s $API/classes/$CLASS_ID/outline -H "Authorization: Bearer $T" | jq -r '.units[0].id')
LESSON=$(curl -s -X POST $API/classes/$CLASS_ID/lessons -H "Authorization: Bearer $T" -H "$JSON" \
  -d "{\"title\":\"Equations\",\"unitId\":\"$UNIT\"}" | jq -r .id)
HOMEWORK=$(curl -s -X PUT "$API/lessons/$LESSON/homework?classId=$CLASS_ID" -H "Authorization: Bearer $T" -H "$JSON" \
  -d '{"type":"text","instructionsText":"Solve x + 2 = 5"}' | jq -r .homework.id)

# The student hands it in. (For draw or photo homework: -F pages=@page1.png -F pages=@page2.png)
SUBMISSION=$(curl -s -X POST "$API/homeworks/$HOMEWORK/submissions?classId=$CLASS_ID" -H "Authorization: Bearer $S" -H "$JSON" \
  -d '{"text":"x = 3"}' | jq -r .id)

# The teacher sees it on the grading page and grades it; the student gets a notification.
curl -s "$API/lessons/$LESSON/grading?classId=$CLASS_ID" -H "Authorization: Bearer $T"
curl -s -X PUT $API/submissions/$SUBMISSION/grade -H "Authorization: Bearer $T" -H "$JSON" -d '{"value":5,"comment":"Well done"}'
curl -s $API/notifications -H "Authorization: Bearer $S"
curl -s $API/student/grades -H "Authorization: Bearer $S"

# 15 minutes later the access token expires (401 TOKEN_EXPIRED): get a new one with the cookie.
T=$(curl -s -b teacher.jar -c teacher.jar -X POST $API/auth/refresh | jq -r .accessToken)
```
