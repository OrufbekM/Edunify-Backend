# Edunify backend

The REST API behind Edunify, a homework platform for schools. Teachers organise classes into lessons, set homework, and grade what students hand in, optionally with suggestions from Claude. Students link to their classes, submit text, code, drawings or photos, and see their grades.

Built with Node.js 24, Express 5, PostgreSQL 17 and Sequelize. Uploaded files are stored on local disk.

- [Running it locally](#running-it-locally)
- [How the API works](#how-the-api-works): base URL, sign-in, errors, limits, files
- [Data shapes](#data-shapes)
- [Endpoints](#endpoints)
- [A full example](#a-full-example): from an empty class to a grade
- [Deployment](docs/deploy.md)

## Running it locally

You need Node.js 24 and PostgreSQL 17.

```sh
npm install
cp .env.example .env        # then fill in the values, see below
npm run migrate             # creates the tables in the database DATABASE_URL names
npm run dev                 # http://localhost:3000, restarts on file changes
```

`.env` holds:

| Variable | Meaning |
|---|---|
| `NODE_ENV` | `development`, `production` or `test` |
| `PORT` | HTTP port, default `3000` |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | at least 32 characters |
| `FILE_URL_SECRET` | at least 32 characters, different from the JWT secret |
| `STORAGE_DIR` | absolute path where uploaded files are kept |
| `ANTHROPIC_API_KEY` | optional; without it AI grading answers `503 AI_UNAVAILABLE` |
| `AI_MODEL` | the Claude model used for AI grading, for example `claude-opus-5-5` |

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

CI runs typecheck, lint, the tests and the build on every push to `main` and `dev` and on every pull request.

## How the API works

### Basics

- Every path starts with `/api/v1`. Requests and responses are JSON with `camelCase` keys, except the file uploads, which are `multipart/form-data`.
- A single resource comes back as itself, with no wrapper. Lists come back as `{ "items": [...] }`. There is no pagination; the [caps](#limits) keep lists small.
- `201` means created, `200` read or updated, `202` a job was started, and `204` (with an empty body) a delete or a mark-read.
- Ids are UUIDs. Times are ISO 8601 in UTC with milliseconds, like `2026-11-05T07:08:09.123Z`.
- Request bodies are strict: an unknown field is a `400 VALIDATION_ERROR`.
- Text is trimmed before it is checked, so `"  Maths "` is stored as `"Maths"`. Passwords are the exception: they are used exactly as typed.
- Optional text that is empty after trimming (a class name, homework instructions, a grade comment) is stored as `null`.

### Who can call what

Each endpoint below lists who may call it:

| Mark | Meaning |
|---|---|
| Public | no sign-in |
| T | teachers only; students get `403 FORBIDDEN` |
| S | students only; teachers get `403 FORBIDDEN` |
| T, S | both, each seeing only their own |
| Any | any signed-in user |

Teachers only ever see their own classes. Students only see a class while they have an **active link** to it, which takes two steps in either order:

1. The teacher adds the student to the class roster with the student's ID (`studentPublicId`).
2. The student enters the class ID (`classPublicId`) through `POST /student/claims`.

Asking for something you don't own or aren't linked to gives the same `404 NOT_FOUND` as asking for something that doesn't exist, so the API never reveals whether it exists.

### Signing in and staying signed in

1. `POST /auth/register` or `POST /auth/login` returns `{ user, accessToken }` and sets the refresh cookie `edunify_rt`. The cookie is `HttpOnly`, `SameSite=Strict`, sent only to `/api/v1/auth`, lasts 30 days, and is `Secure` in production.
2. Send the access token on every other call: `Authorization: Bearer <accessToken>`. It lasts 15 minutes. Keep it in memory only, never in `localStorage`.
3. When a call answers `401` with code `TOKEN_EXPIRED`, call `POST /auth/refresh` once (the browser sends the cookie), then repeat the call with the new token. Browsers need `withCredentials: true` (or `credentials: 'include'`) for the cookie to travel.
4. Any other `401` means the session is over: show the sign-in page.
5. On app start, call `POST /auth/refresh`. A `401` means nobody is signed in.

Every refresh replaces the refresh token with a new one. If several tabs refresh with the same token within 10 seconds of each other, each of them gets a fresh access token, but no new cookie. Using an old refresh token after that, or after sign-out, ends that session everywhere (`401 UNAUTHENTICATED`).

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
| `INVALID_CREDENTIALS` | 401 | Wrong email, password, or current password |
| `FORBIDDEN` | 403 | This role may not use the endpoint |
| `FILE_URL_INVALID` | 403 | The signed file URL is invalid or has expired |
| `NOT_FOUND` | 404 | Doesn't exist, or you can't see it |
| `STUDENT_ID_NOT_FOUND` | 404 | No student has that ID |
| `CLASS_ID_NOT_FOUND` | 404 | No class has that ID |
| `EMAIL_TAKEN` | 409 | The email is already registered |
| `CATEGORY_NAME_TAKEN` | 409 | You already have a category with this name (case doesn't matter) |
| `CATEGORY_NOT_EMPTY` | 409 | The category still has classes |
| `STUDENT_ID_IN_USE` | 409 | That student already has a row in this class |
| `HOMEWORK_TYPE_LOCKED` | 409 | The homework type can't change once there are submissions |
| `SUBMISSION_NOT_LATEST` | 409 | Only the latest version of a submission can be graded |
| `AI_JOB_ACTIVE` | 409 | AI grading is already running for this lesson; `details.jobId` names the job |
| `LIMIT_REACHED` | 409 | A cap was hit (see below) |
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

| Field | Rule |
|---|---|
| `email` | valid email, up to 254 characters, stored in lowercase |
| `password` | 8 to 128 characters |
| `fullName` (user or roster row) | 1 to 100 |
| Category `name` | 1 to 60 |
| Class `subject` / `name` | 1 to 80 / 0 to 80 |
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
type Role = 'teacher' | 'student'
type HomeworkType = 'text' | 'draw' | 'math' | 'code' | 'photo'   // math works exactly like draw
type SubmissionStatus = 'submitted' | 'denied' | 'graded'
type CellStatus = 'empty' | 'submitted' | 'denied' | 'graded'    // 'empty' = nothing handed in yet
type LinkState = 'no_id' | 'awaiting_student' | 'active'
type NotificationKind = 'graded' | 'denied' | 'submitted'
type JobStatus = 'queued' | 'running' | 'done' | 'failed'
type Grade = 2 | 3 | 4 | 5

interface User {
  id: string
  role: Role
  fullName: string
  email: string
  publicId: string | null      // students only; null for teachers
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

interface Category { id: string; name: string; classCount: number; createdAt: string }

interface Class {
  id: string
  categoryId: string
  subject: string
  name: string | null
  publicId: string             // show as #XXXX-XXXX
  studentCount: number
  createdAt: string
}

interface ClassStudent {
  id: string
  fullName: string                 // the name on the teacher's roster
  studentPublicId: string | null   // the student's ID the teacher entered, or null
  linkState: LinkState             // no_id, awaiting_student (no claim yet), active
}

interface Unit { id: string; classId: string; title: string; order: number }

interface LessonSummary {
  id: string
  unitId: string | null
  title: string
  order: number
  homeworkType: HomeworkType | null    // null = no homework
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
  classId: string
  unitId: string | null
  title: string
  order: number
  lessonFile: FileRef | null
  homework: Homework | null
  mySubmission?: Submission | null     // students only: their latest version
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
  classSubject: string
  className: string | null
  studentName: string | null   // the roster name, on a teacher's 'submitted' notification only
  createdAt: string
}
```

## Endpoints

All paths below start with `/api/v1`.

### Health and sign-in

| Endpoint | Who | What it does |
|---|---|---|
| `GET /health` | Public | Answers `200 { "status": "ok" }` when the server is up. |
| `POST /auth/register` | Public | Creates an account and signs it in. Body `{ role, fullName, email, password }`. Returns `201 { user, accessToken }` and sets the refresh cookie. Students get their `publicId` here. Error: `EMAIL_TAKEN`. |
| `POST /auth/login` | Public | Signs in. Body `{ email, password }`. Returns `200 { user, accessToken }` and sets the refresh cookie. Error: `INVALID_CREDENTIALS`. |
| `POST /auth/refresh` | Cookie | Swaps the refresh cookie for a new access token. No body. Returns `200 { user, accessToken }` and a new cookie. Error: `UNAUTHENTICATED`. |
| `POST /auth/logout` | Cookie | Signs out: ends the cookie's session and clears the cookie. No body. Returns `204`, also when there is no cookie. |
| `GET /me` | Any | Returns `200 User`. |
| `PATCH /me` | Any | Changes your name. Body `{ fullName }`. Returns `200 User`. |
| `POST /me/password` | Any | Changes your password. Body `{ currentPassword, newPassword }`. Returns `204` with a fresh refresh cookie for you, and signs out every other session. Error: `INVALID_CREDENTIALS` (wrong current password). |

### Categories (teachers)

Categories group a teacher's classes.

| Endpoint | What it does |
|---|---|
| `GET /categories` | Your categories, sorted by name. `200 { items: Category[] }` |
| `POST /categories` | Body `{ name }`. `201 Category`. Errors: `CATEGORY_NAME_TAKEN`, `LIMIT_REACHED`. |
| `PATCH /categories/:id` | Renames it. Body `{ name }`. `200 Category`. Error: `CATEGORY_NAME_TAKEN`. |
| `DELETE /categories/:id` | `204`. Error: `CATEGORY_NOT_EMPTY` while it still has classes. |

### Classes (teachers)

| Endpoint | What it does |
|---|---|
| `GET /classes?categoryId=` | Your classes, newest first; `categoryId` is an optional filter. `200 { items: Class[] }` |
| `POST /classes` | Body `{ categoryId, subject, name? }`. `201 Class`, with its generated `publicId` to give to students. Errors: `LIMIT_REACHED`, `VALIDATION_ERROR` for a category that isn't yours. |
| `GET /classes/:id` | `200 Class` |
| `PATCH /classes/:id` | Body `{ categoryId?, subject?, name? }`; `name: null` clears the name. `200 Class` |
| `DELETE /classes/:id` | Deletes the class with everything in it: roster, lessons, homework, submissions, grades and files. `204` |

### Class roster (teachers)

Each row is one student in the class, with the name the teacher knows them by. A row keeps its submissions and grades even if the student's account changes.

| Endpoint | What it does |
|---|---|
| `GET /classes/:classId/students` | The roster, sorted by name, each row with its `linkState`. `200 { items: ClassStudent[] }` |
| `POST /classes/:classId/students` | Adds a row. Body `{ fullName, studentPublicId? }`. `201 ClassStudent`. Errors: `STUDENT_ID_NOT_FOUND`, `STUDENT_ID_IN_USE`, `LIMIT_REACHED`. |
| `PATCH /classes/:classId/students/:id` | Body `{ fullName?, studentPublicId? }`. A new `studentPublicId` moves the row to another account, for a student who lost theirs; the old account loses access at once. `studentPublicId: null` unlinks the row. `200 ClassStudent`. Same errors as adding. |
| `DELETE /classes/:classId/students/:id` | Deletes the row with its submissions and grades. `204` |

### Student side (students)

| Endpoint | What it does |
|---|---|
| `POST /student/claims` | Enters a class ID. Body `{ classPublicId }`. Returns `200 { "saved": true }` for any existing class, whether or not the teacher has added you yet, and doing it twice is harmless. Error: `CLASS_ID_NOT_FOUND`. |
| `GET /student/classes` | Classes you have an active link to, sorted by subject. `200 { items: [{ id, subject, name, teacherName, classStudentId }] }` |

### Outline, units and lessons

A class's lessons can be grouped into units. Lessons without a unit come first. `order` is the 0-based position among siblings; the server keeps positions continuous when you add, move or delete.

| Endpoint | Who | What it does |
|---|---|---|
| `GET /classes/:classId/outline` | T, S | The class's structure: `200 { units: Unit[], lessons: LessonSummary[] }`. Units in order; lessons without a unit first, then each unit's lessons in order. |
| `POST /classes/:classId/units` | T | Body `{ title }`. Adds it at the end. `201 Unit`. Error: `LIMIT_REACHED`. |
| `PATCH /units/:id` | T | Body `{ title?, order? }`; `order` moves it to that position. `200 Unit`. An `order` out of range is a `VALIDATION_ERROR`. |
| `DELETE /units/:id` | T | Deletes the unit and its lessons. `204` |
| `POST /classes/:classId/lessons` | T | Body `{ title, unitId? }`. Adds it at the end of its group. `201 LessonDetail`. Errors: `LIMIT_REACHED`, `VALIDATION_ERROR` for a unit of another class. |
| `GET /lessons/:id` | T, S | `200 LessonDetail`. Students also get `mySubmission`: their latest version, or `null`. |
| `PATCH /lessons/:id` | T | Body `{ title?, unitId?, order? }`; `unitId: null` moves it out of its unit. `200 LessonDetail` |
| `DELETE /lessons/:id` | T | Deletes the lesson with its homework and submissions. `204` |

### Lesson file and homework (teachers)

Each lesson can have one file to read and one piece of homework. Uploads are `multipart/form-data` with the file in the field `file`.

| Endpoint | What it does |
|---|---|
| `PUT /lessons/:id/lesson-file` | Uploads or replaces the lesson's file (`.md` or `.pdf`). `200 LessonDetail` |
| `DELETE /lessons/:id/lesson-file` | Removes it. `200 LessonDetail` |
| `PUT /lessons/:id/homework` | Creates or replaces the homework. Body `{ type, instructionsText? }`; leaving `instructionsText` out clears it, and an instructions file stays. `200 LessonDetail`. Error: `HOMEWORK_TYPE_LOCKED` when changing the type after students have submitted. |
| `DELETE /lessons/:id/homework` | Deletes the homework with all its submissions and grades. `200 LessonDetail` |
| `PUT /lessons/:id/homework/file` | Uploads or replaces an instructions file (`.md` or `.pdf`). Needs homework first. `200 LessonDetail` |
| `DELETE /lessons/:id/homework/file` | Removes it. `200 LessonDetail` |

### Submissions

Each hand-in is a new version; earlier versions and their grades stay.

| Endpoint | Who | What it does |
|---|---|---|
| `POST /homeworks/:homeworkId/submissions` | S | Hands in the homework. The body depends on the homework type: **text** JSON `{ text }`; **code** JSON `{ html, css, js }`; **draw**, **math**, **photo** `multipart/form-data` with 1 to 9 files in the repeated field `pages`, in page order. Returns `201 Submission` with the next version number, and notifies the teacher. Errors: `VALIDATION_ERROR` (content doesn't fit the type), `LIMIT_REACHED` (30 versions, or a 10th page), `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, and `NOT_FOUND` without an active link to the class. |
| `GET /student/submissions?classId=` | S | Your latest version of each homework, newest first; `classId` is an optional filter. `200 { items: [{ submission, lesson: { id, title }, class: { id, subject, name } }] }` |
| `GET /submissions/:id` | T, S | One version, with the list of all versions of that homework by that student, newest first. `200 Submission & { versions: SubmissionVersion[] }` |

### Grading (teachers)

| Endpoint | What it does |
|---|---|
| `GET /lessons/:lessonId/grading` | Everything to grade one lesson: `200 { lesson: { id, title }, homework: Homework, items: [{ classStudentId, fullName, submission }] }`. One item per roster row, sorted by name; `submission` is that student's latest version, with any AI suggestion, or `null`. `404` if the lesson has no homework. |
| `PUT /submissions/:id/grade` | Grades the latest version: `{ value: 2-5, comment?, fromAi? }`, or sends it back: `{ denied: true, comment }`. A second call replaces the grade. `fromAi: true` confirms the AI suggestion (you may change its value or comment) and marks the grade `ai_confirmed`. Returns `200 Submission` and notifies the student. Errors: `SUBMISSION_NOT_LATEST`, and `VALIDATION_ERROR` for both or neither of `value` and `denied`, a denial without a comment, or `fromAi` with no suggestion. |
| `DELETE /submissions/:id/grade` | Removes the grade: the submission goes back to `submitted`, and the student's unread notification for it disappears. `200 Submission`. Error: `SUBMISSION_NOT_LATEST`. |

### Journal and grades

Both show only lessons that have homework, as columns in outline order, with one cell per lesson from the latest version. `average` is the mean of the graded cells, to 2 decimal places; denied and empty cells don't count, and it is `null` when nothing is graded.

| Endpoint | Who | What it does |
|---|---|---|
| `GET /classes/:classId/journal` | T | The whole class: `200 { units: Unit[], columns: [{ lessonId, title, unitId }], rows: [{ classStudentId, fullName, linkState, cells: JournalCell[], average }] }`. Rows are sorted by name; `cells` line up with `columns`. |
| `GET /student/grades` | S | Your own grades, one item per class: `200 { items: [{ class: { id, subject, name }, columns, cells, average }] }` |

### AI grading (teachers)

Claude reads the lesson's Markdown file, the homework instructions and the student's work, and suggests a grade and a comment. It never grades on its own: the suggestion is shown only to the teacher, who confirms it with `PUT /submissions/:id/grade` and `fromAi: true`. PDFs are not sent to Claude. A page image larger than Claude takes is scaled down to 2576 px on its long edge for Claude only; the stored page the teacher sees is unchanged.

| Endpoint | What it does |
|---|---|
| `POST /lessons/:lessonId/ai-grade` | Starts a job. Body `{ submissionIds? }`: leave it out for every latest submission still waiting for a grade, or list specific ones (`[id]` for one student). Returns `202 AiJob`. Errors: `AI_JOB_ACTIVE` (with `details.jobId` of the running job), `VALIDATION_ERROR` (ids that aren't latest versions in this lesson, or nothing to grade), `AI_UNAVAILABLE`, `RATE_LIMITED` (5 a minute). |
| `GET /ai-jobs/:id` | The job's progress: `200 AiJob`. Poll it every 2 seconds while `status` is `queued` or `running`; when it turns `done` or `failed`, reload the grading page. `done` means every submission was processed, some perhaps in `failed`; `failed` means the job itself couldn't run, with the reason in `error`. |

### Notifications (any signed-in user)

Teachers get `submitted` when a student hands something in; students get `graded` or `denied`. There is at most one notification per user and submission: a new event on the same submission updates it and makes it unread again.

| Endpoint | What it does |
|---|---|
| `GET /notifications/count` | `200 { unreadCount }`, cheap enough to poll. |
| `GET /notifications` | Unread notifications, newest first, at most 100. `200 { items: NotificationItem[] }` |
| `POST /notifications/:id/read` | Marks one read. No body. `204`, also if it was already read. Mark a teacher's notification read when they open the submission, and a student's when they open the homework. |

### Files

| Endpoint | Who | What it does |
|---|---|---|
| `GET /files/:id?exp=&sig=` | Signed URL | The file's bytes, with the right `Content-Type`. Use the `url` from a `FileRef` as it is. Errors: `FILE_URL_INVALID` (expired or altered link), `NOT_FOUND` (the file was removed). |

## A full example

From an empty class to a grade, with `curl` against a local server. `jq` pulls fields out of the responses.

```sh
API=http://localhost:3000/api/v1
JSON='Content-Type: application/json'

# A teacher signs up. The access token goes in a variable, the refresh cookie in a cookie jar.
T=$(curl -s -c teacher.jar -X POST $API/auth/register -H "$JSON" \
  -d '{"role":"teacher","fullName":"Teacher One","email":"teacher@example.com","password":"long-password-1"}' | jq -r .accessToken)

# A student signs up and gets a public ID to give the teacher.
STUDENT=$(curl -s -X POST $API/auth/register -H "$JSON" \
  -d '{"role":"student","fullName":"Student One","email":"student@example.com","password":"long-password-2"}')
S=$(echo "$STUDENT" | jq -r .accessToken)
STUDENT_ID=$(echo "$STUDENT" | jq -r .user.publicId)

# The teacher makes a category and a class, and adds the student by ID.
CATEGORY=$(curl -s -X POST $API/categories -H "Authorization: Bearer $T" -H "$JSON" -d '{"name":"Mathematics"}' | jq -r .id)
CLASS=$(curl -s -X POST $API/classes -H "Authorization: Bearer $T" -H "$JSON" \
  -d "{\"categoryId\":\"$CATEGORY\",\"subject\":\"Algebra\",\"name\":\"7A\"}")
CLASS_ID=$(echo "$CLASS" | jq -r .id)
CLASS_PUBLIC_ID=$(echo "$CLASS" | jq -r .publicId)
curl -s -X POST $API/classes/$CLASS_ID/students -H "Authorization: Bearer $T" -H "$JSON" \
  -d "{\"fullName\":\"Ali Valiyev\",\"studentPublicId\":\"$STUDENT_ID\"}"      # linkState: awaiting_student

# The student enters the class ID: the link is now active.
curl -s -X POST $API/student/claims -H "Authorization: Bearer $S" -H "$JSON" -d "{\"classPublicId\":\"$CLASS_PUBLIC_ID\"}"

# The teacher adds a lesson with text homework.
LESSON=$(curl -s -X POST $API/classes/$CLASS_ID/lessons -H "Authorization: Bearer $T" -H "$JSON" -d '{"title":"Equations"}' | jq -r .id)
HOMEWORK=$(curl -s -X PUT $API/lessons/$LESSON/homework -H "Authorization: Bearer $T" -H "$JSON" \
  -d '{"type":"text","instructionsText":"Solve x + 2 = 5"}' | jq -r .homework.id)

# The student hands it in. (For draw or photo homework: -F pages=@page1.png -F pages=@page2.png)
SUBMISSION=$(curl -s -X POST $API/homeworks/$HOMEWORK/submissions -H "Authorization: Bearer $S" -H "$JSON" \
  -d '{"text":"x = 3"}' | jq -r .id)

# The teacher sees it on the grading page and grades it; the student gets a notification.
curl -s $API/lessons/$LESSON/grading -H "Authorization: Bearer $T"
curl -s -X PUT $API/submissions/$SUBMISSION/grade -H "Authorization: Bearer $T" -H "$JSON" -d '{"value":5,"comment":"Well done"}'
curl -s $API/notifications -H "Authorization: Bearer $S"
curl -s $API/student/grades -H "Authorization: Bearer $S"

# 15 minutes later the access token expires (401 TOKEN_EXPIRED): get a new one with the cookie.
T=$(curl -s -b teacher.jar -c teacher.jar -X POST $API/auth/refresh | jq -r .accessToken)
```
