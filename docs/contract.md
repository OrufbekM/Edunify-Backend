# Edunify: Contract

Single source of truth shared by the frontend and the backend: stacks, conventions, data model, authorization, and the full REST API.

- If the frontend or the backend needs something this file does not say, change this file first, then the code.
- Frontend internals (folders, UI, flows) live in `docs/techspec.md`. This file wins on anything about the API, data, or shared rules. `techspec.md` §13 is superseded by section 8 here.
- Everything here is a decision, not a proposal.

---

## 1. Tech Stacks

### 1.1 Frontend (strict: no additions without approval)

| Area | Package (major) |
|---|---|
| Build | Vite 8 + `@vitejs/plugin-react` 6, npm |
| Language | TypeScript ~6.0, `strict`, `.ts`/`.tsx` only |
| UI | React 19 |
| Routing | React Router 7 (`react-router`, `createBrowserRouter`, lazy routes) |
| Server state | TanStack React Query 5 |
| Client state | Zustand 5 (auth session, theme, sidebar only) |
| HTTP | Axios 1, one instance in `src/services/api.ts` |
| Validation | zod 4 (every response is parsed in the service layer) |
| Styling | Tailwind CSS 4 via `@tailwindcss/vite` |
| Icons | lucide-react 1 |
| i18n | i18next 26 + react-i18next 17 (v0: `en` only) |
| Markdown | `react-markdown` + `remark-gfm`, raw HTML disabled |
| Mocks | `@faker-js/faker` 10 (dev), only in `src/services/mocks/` |
| Lint | ESLint 10 + typescript-eslint 8 + react-hooks + react-refresh |

### 1.2 Backend (strict: no additions without approval)

| Area | Choice |
|---|---|
| Runtime | Node.js 24 LTS, ESM |
| Language | TypeScript ~6.0, `strict`, run with `tsx` in dev, compiled with `tsc` for production |
| HTTP | Express 5 |
| Database | PostgreSQL 17 |
| ORM / migrations | Sequelize 6 + `umzug` migrations (`underscored: true`, models in TypeScript) |
| Validation | zod 4 (request bodies, query, params, env) |
| Auth | `jsonwebtoken` (HS256) access tokens, `argon2` password hashing, `cookie-parser` |
| Uploads | `multer` (memory storage, then validated and written through the storage layer) |
| Security | `helmet`, `express-rate-limit` |
| Logging | `pino` + `pino-http` |
| AI | `@anthropic-ai/sdk` (model from env `AI_MODEL`) |
| Tests | Vitest + Supertest (covers auth, the connection logic, class groups, lesson numbering, authorization, grading rules) |
| Lint | ESLint 10 + typescript-eslint 8 |

Rules:
- Exact versions live in each `package.json`. Never upgrade a major without asking.
- No Redis, queues, GraphQL, WebSockets, or extra frameworks. Background work uses the `ai_jobs` table and an in-process worker (section 9).
- No CORS: production serves the frontend and `/api/v1` from the same origin. Dev uses the Vite proxy (`/api` -> backend).
- The two codebases do not share a package. Each implements its own zod schemas from this file.

### 1.3 Topology

```
Browser -> (same origin) -> reverse proxy -> /        static frontend build (Vite)
                                          -> /api/v1  Express -> PostgreSQL
                                                              -> storage dir (files)
                                                              -> Anthropic API (AI grading)
```

---

## 2. Conventions

### 2.1 HTTP and JSON
- Base path: `/api/v1`. Breaking changes require `/api/v2`.
- JSON in and out, `camelCase` keys, UTF-8. Request JSON body limit: 1 MB.
- Multipart only where this file says so (file uploads).
- Success: the resource itself, with no envelope. Lists: `{ "items": [...] }`. No pagination except the admin user list (section 8.14); other lists are bounded by the caps in section 2.7.
- `201` for creation, `200` for reads and updates, `202` for starting a job, `204` (empty body) for deletes and mark-read.
- Updates are `PATCH` (partial) or `PUT` (replace). Last write wins; no ETags.
- Unknown JSON fields in requests are rejected with `VALIDATION_ERROR`.

### 2.2 Identifiers and time
- Every `id` is a UUID v4 string (`gen_random_uuid()`).
- Public IDs (students and classes) are separate values, see section 6.
- Timestamps are ISO 8601 UTC strings with milliseconds, for example `2026-11-05T07:08:09.123Z`.
- The frontend formats dates with `Intl` in the browser's time zone.

### 2.3 Authentication
- Authenticated routes send `Authorization: Bearer <accessToken>`.
- Access token: JWT HS256, TTL 15 minutes, claims `sub` (user id), `role`, `iat`, `exp`.
- Refresh token: opaque 256-bit random string, TTL 30 days, stored only as a SHA-256 hash.
- Refresh cookie: name `edunify_rt`, `HttpOnly`, `Secure` (not on `http://localhost`), `SameSite=Strict`, `Path=/api/v1/auth`, `Max-Age=2592000`.
- Rotation: every `POST /auth/refresh` revokes the used token and issues a new one in the same family. Reusing a revoked token revokes the whole family and returns `401 UNAUTHENTICATED`. A token reused within 10 seconds of its rotation is accepted once more (multi-tab race) and returns a fresh access token only.
- The frontend keeps the access token in memory only (never `localStorage`), sets `withCredentials: true`, and on `401` with code `TOKEN_EXPIRED` performs one single-flight refresh and retries the request once. Any other `401` clears the session, except `INVALID_CREDENTIALS`, which is a form error (wrong password) and keeps the session.
- On app load the frontend calls `POST /auth/refresh`; `401` means logged out.
- Account state is read from the database on every authenticated request (never trusted from the token). Checks run in this order:
  1. `status = 'blocked'` -> `403 ACCOUNT_BLOCKED`.
  2. `mustChangePassword = true` -> `403 PASSWORD_CHANGE_REQUIRED`.
  3. `status = 'pending'` (teachers) -> `403 ACCOUNT_PENDING`.
  Steps 2 and 3 apply to every route except `/health`, `/auth/*`, `/me`, and `/me/password`, which stay reachable so the user can see the gate, change the password, or log out.
- There is no email or SMS verification anywhere: signup never confirms an email address or phone number, and nothing is ever sent to the user.

### 2.4 Errors
Every non-2xx response has this shape:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "English text for logs", "details": [ { "path": "fullName", "message": "Required" } ] } }
```

- `code` is stable and machine-readable (section 10). The frontend shows text from i18n key `errors.<code>`, never `message`.
- `details` is present only for `VALIDATION_ERROR` (array of `{ path, message }`) and where an endpoint says so.
- Status policy: wrong role -> `403 FORBIDDEN`. A resource the caller does not own or is not connected to -> `404 NOT_FOUND` (never reveal existence).

### 2.5 Rate limits
Exceeding a limit returns `429 RATE_LIMITED` with a `Retry-After` header (seconds).

| Scope | Limit |
|---|---|
| `POST /auth/login` | 10 per 15 min per IP + email |
| `POST /auth/register` | 10 per hour per IP |
| `POST /auth/admin/login` | 5 per 15 min per IP |
| Public-ID lookups (`POST /student/claims`, student create/update with `studentPublicId`) | 30 per 10 min per user |
| `POST /lessons/:id/ai-grade` | 5 per minute per user |
| Everything else | 300 per minute per user |

### 2.6 Validation limits
Strings are trimmed before validation, except passwords (`password`, `confirmPassword`, `currentPassword`, `newPassword`, `confirmNewPassword`) and code (`html`, `css`, `js`), which are validated and stored as sent. "Empty" means length 0 after trimming.

| Field | Rule |
|---|---|
| `email` | valid email, max 254, stored lowercase |
| `password` | 8-128 characters |
| `firstName`, `lastName` (user) | 1-50 each |
| `phone` (teacher) | after normalization (remove spaces, dashes, parentheses) must match `^\+[1-9]\d{7,14}$` (international format with `+`) |
| `confirmPassword` | must equal `password` (else `VALIDATION_ERROR` with path `confirmPassword`) |
| Admin `login` | lowercased, then 3-40, `^[a-z0-9_]+$` |
| `fullName` (class student, entered by the teacher) | 1-100 |
| Category `name` | 1-60, unique per teacher, case-insensitive |
| Class `name` | 1-80 |
| `linkedClassIds` | 0-9 distinct ids of the caller's own classes, never the class itself |
| Unit / lesson `title` | 1-120 |
| Homework `instructionsText` | 0-10 000 |
| Text submission `text` | 1-20 000 |
| Code submission `html`, `css`, `js` | each 0-100 000; at least one non-empty |
| Grade `comment` | 0-2 000 (1-2 000 when denying) |
| `studentPublicId`, `classPublicId` | after normalization (section 6.1) must match `^[a-z0-9]{8}$` |

### 2.7 Caps
Creating beyond a cap returns `409 LIMIT_REACHED`.

| Item | Cap |
|---|---|
| Categories per teacher | 100 |
| Classes per teacher | 100 |
| Students per class | 200 |
| Units per class | 100 |
| Lessons per class | 500 |
| Pages per submission | 9 |
| Versions per student per homework | 30 |
| Classes per group | 10 |

Units and lessons per class count the group's units and linked lessons too. If creating or linking an item would push any class of a group over a cap, nothing changes and `LIMIT_REACHED` returns `details: { classIds }` (the classes over the cap).

---

## 3. Enums and Shared Types

```ts
type Role = 'teacher' | 'student' | 'admin'
type UserStatus = 'pending' | 'active' | 'blocked'   // teachers start 'pending'; students and the admin are 'active'
type HomeworkType = 'text' | 'draw' | 'math' | 'code' | 'photo'   // math is rendered and stored exactly like draw
type SubmissionStatus = 'submitted' | 'denied' | 'graded'
type CellStatus = 'empty' | 'submitted' | 'denied' | 'graded'    // 'empty' = no submission yet
type ConnectionState = 'not_connected' | 'awaiting_student' | 'connected'
type NotificationKind = 'graded' | 'denied'
type JobStatus = 'queued' | 'running' | 'done' | 'failed'
type Grade = 2 | 3 | 4 | 5
```

```ts
interface User {
  id: string
  role: Role
  firstName: string
  lastName: string
  email: string | null         // teachers and students; null for the admin
  phone: string | null         // teachers only (normalized, with +)
  login: string | null         // admin only
  publicId: string | null      // 8 chars, students only
  status: UserStatus
  mustChangePassword: boolean  // true after an admin password reset
  createdAt: string
}

interface FileRef {
  id: string
  name: string                 // original file name
  mime: string
  size: number                 // bytes
  url: string                  // signed, see section 7
  expiresAt: string
}

interface Category { id: string; name: string; order: number; classCount: number; createdAt: string }

interface Class {
  id: string
  categoryId: string
  order: number               // 0-based index within its category
  name: string
  publicId: string             // 8 chars; shown to the teacher as #XXXX-XXXX
  studentCount: number
  newSubmissionCount: number   // new homework submissions: latest versions with status 'submitted', over every lesson of the class (hidden ones too)
  linkedClasses: { id: string; name: string }[]   // the other classes in its group; empty = not in a group
  createdAt: string
}

interface ClassStudent {
  id: string
  fullName: string
  studentPublicId: string | null   // the ID the teacher entered; null if none
  connectionState: ConnectionState
}

interface Unit {
  id: string
  classId: string
  title: string
  order: number                        // 0-based within the class; in a group the same in every class
}

interface LessonSummary {
  id: string
  unitId: string                       // every lesson belongs to a unit
  number: number                       // 1-based, continuous across units in outline order; computed by the server, never stored
  title: string
  order: number                        // 0-based within its unit in this class
  homeworkType: HomeworkType | null    // null = lesson has no homework
  linked?: boolean                     // teacher responses only
  visible?: boolean                    // teacher responses only; students only ever receive visible lessons
  newSubmissionCount?: number          // teacher responses only: this class's latest versions with status 'submitted'; 0 without a homework
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
  unitId: string
  number: number
  title: string
  order: number
  lessonFile: FileRef | null
  homework: Homework | null
  linked?: boolean                     // teacher only
  visible?: boolean                    // teacher only
  mySubmission?: Submission | null     // present only for students: their latest version
}

type SubmissionContent =
  | { type: 'text'; text: string }
  | { type: 'code'; html: string; css: string; js: string }
  | { type: 'draw' | 'math' | 'photo'; pages: FileRef[] }   // 1-9 pages in order

interface GradeInfo {
  value: Grade | null
  denied: boolean              // exactly one of: value != null, denied = true
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
  aiSuggestion?: AiSuggestion | null   // teacher responses only; never sent to students
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
  completed: number
  failed: number
  error: string | null
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

interface ContentImpact { classes: { id: string; name: string; submissionCount: number }[] }   // every class holding the item, this class included
interface GroupPreviewItem { classId: string; name: string; addedUnits: number; addedLessons: number; convertedUnits: number; convertedLessons: number }
```

---

## 4. Data Model (PostgreSQL)

Columns are `snake_case` (Sequelize `underscored: true`). Every table has `created_at` and `updated_at` (`timestamptz`, default now) unless noted. All foreign keys are indexed.

| Table | Columns and constraints |
|---|---|
| `users` | `id` uuid pk; `role` enum(`teacher`,`student`,`admin`); `first_name`; `last_name`; `email` citext unique null; `phone` null; `login` citext unique null; `password_hash`; `status` enum(`pending`,`active`,`blocked`); `must_change_password` bool default false; `public_id` char(8) unique null. Checks: teacher -> `email` and `phone` not null, `public_id` null; student -> `email` and `public_id` not null, `phone` null; admin -> `login` not null, `email`, `phone`, `public_id` null. |
| `refresh_tokens` | `id`; `user_id` fk cascade; `family_id` uuid; `token_hash` unique; `expires_at`; `revoked_at` null; `replaced_at` null. |
| `categories` | `id`; `teacher_id` fk users; `name`; `position` int. Unique `(teacher_id, lower(name))`. |
| `classes` | `id`; `category_id` fk categories (restrict); `teacher_id` fk users (denormalized for authorization); `name`; `position` int; `public_id` char(8) unique; `group_id` fk class_groups null (set null). |
| `class_groups` | `id`. A group exists only while it has two or more classes. |
| `class_students` | `id`; `class_id` fk cascade; `full_name`; `student_user_id` fk users null (set null on user delete). Unique `(class_id, student_user_id)` where not null. |
| `class_claims` | `id`; `student_user_id` fk cascade; `class_id` fk cascade. Unique `(student_user_id, class_id)`. |
| `connection_audit` | `id`; `class_student_id` fk cascade; `old_user_id` null; `new_user_id` null; `changed_by` fk users; `created_at` only. |
| `units` | `id`; `title`; `class_id` fk classes cascade null (a class not in a group); `group_id` fk class_groups cascade null (a group's unit). Exactly one of the two is set. |
| `class_units` | `id`; `class_id` fk cascade; `unit_id` fk cascade; `position` int. Unique `(class_id, unit_id)`. The placement of a unit in a class. Every class keeps at least one placement. In a group every class holds every unit of the group at the same `position`. |
| `lessons` | `id`; `unit_id` fk units cascade not null; `title`; `lesson_file_id` fk files null; `class_id` fk classes cascade null (class-only); `group_id` fk class_groups cascade null (linked); `position` int null (linked only: the linked order within its unit, shared by every class). Exactly one of `class_id` and `group_id` is set. |
| `class_lessons` | `id`; `class_id` fk cascade; `lesson_id` fk cascade; `position` int null (class-only lessons only: the lesson's slot in its unit in this class; null for a linked lesson); `visible` bool default true. Unique `(class_id, lesson_id)`. The placement of a lesson in a class. |
| `homeworks` | `id`; `lesson_id` fk cascade unique; `type` enum; `instructions_text` null; `instructions_file_id` fk files null. |
| `files` | `id`; `owner_user_id` fk users; `kind` enum(`lesson`,`instructions`,`page`); `original_name`; `mime`; `size` int; `storage_key` unique. |
| `submissions` | `id`; `homework_id` fk cascade; `class_student_id` fk cascade; `version` int; `status` enum; `content` jsonb null (text or code content; null for page types); `grade_value` smallint null (check 2-5); `grade_denied` bool default false; `grade_comment` null; `grade_source` enum null; `graded_at` null; `ai_suggestion` jsonb null. Unique `(homework_id, class_student_id, version)`. Check: not (`grade_value` is not null and `grade_denied`). |
| `submission_pages` | `id`; `submission_id` fk cascade; `position` int; `file_id` fk files. Unique `(submission_id, position)`. |
| `notifications` | `id`; `user_id` fk cascade; `kind` enum; `submission_id` fk cascade; `read_at` null. Unique `(user_id, submission_id)`. |
| `ai_jobs` | `id`; `lesson_id` fk cascade; `class_id` fk cascade; `created_by` fk users; `status` enum; `submission_ids` uuid[]; `total`; `completed`; `failed`; `error` null; `finished_at` null. |

Rules:
- Grades and submissions belong to `class_students`, never to the user account.
- Deleting a class, unit, lesson, or homework cascades through the tables above (a class leaves its group first, see 4.1). After the transaction commits, the server deletes files that no row references any more from storage.
- `position` values are dense and 0-based within their sibling set (categories within a teacher; classes within their category; `class_units` within a class; `lessons.position` within the group and unit; `class_lessons` slots within a class and the unit of their lesson). The server renumbers siblings when an item is created, moved, or deleted.
- Migrations are the only way to change the schema; models never call `sync()`.

### 4.1 Class groups, shared content, and numbering

Groups:
- A teacher can put two or more of their own classes, in any categories, into a group. A class is in at most one group; a group has at most 10 classes. Adding a class that is already in another group fails with `CLASS_IN_OTHER_GROUP`.

Units in a group:
- Units are never linked or class-only; only lessons are. In a group every unit belongs to the group, and every class of the group holds every unit, with the same title and in the same order. Creating, renaming, or moving a unit does it in every class of the group.
- A unit of a group can be deleted only when no class of the group has a lesson in it (`UNIT_NOT_EMPTY`). Outside a group, deleting a unit cascades to its lessons.
- A unit can be empty in a class (its lessons sit in other classes only). Students never receive a unit without a visible lesson.

Linked and class-only lessons:
- Every lesson is either linked (owned by the group, shared by every class that holds it) or class-only (owned by one class). Homework and the lesson file belong to their lesson, so they are shared exactly when the lesson is linked.
- Editing a linked lesson's title, lesson file, homework type, instructions, or instructions file changes it in every class that holds it.
- A linked lesson sits in the same unit in every class that holds it. A class-only lesson may sit in any unit of its class and appears only in that class.
- Per class, never shared: visibility to students, the slots of class-only lessons, roster, submissions, grades, journal, notifications, AI jobs. Submissions point at the homework and the class student, so student data stays separated by class.
- "Remove from this class only" deletes the placement. The lesson stays in the group and returns to that class only if the class leaves the group and joins again. A linked lesson with no placement left is deleted.
- A "copy" is a new class-only unit, lesson, and homework with the same title, homework type, instructions, and file references. The class's submissions are re-pointed to the copy's homework, and placement, order, and visibility are kept.

Lesson order inside a unit:
- Linked lessons have one linked order per unit, shared by the group (`lessons.position`). Class-only lessons have a slot in this class (`class_lessons.position`).
- A class's list for a unit: each class-only lesson takes its slot (in slot order; a slot past the end goes last), and the linked lessons the class holds fill the remaining positions in linked order. Example: linked order lesson1, lesson3 and class A's class-only lesson2 at slot 1 give class A "lesson1, lesson2, lesson3" and class B "lesson1, lesson3".
- Moving a linked lesson changes the linked order, so it moves in every class: it goes right after the linked lesson that precedes it in this class's list (first if none). Moving a class-only lesson changes only its slot.

Joining, leaving, dissolving (all in one transaction):
- When a class joins, the group's units and linked lessons are placed in it, lessons hidden from students. The class's own units become the group's and are added to every class of the group. The shared unit order is the group's units first, then each joining class's own units in that class's order (when a group is created, the class that creates it counts as the group). The class's own lessons stay class-only and keep their slots.
- When a class leaves, it gets copies of all units and linked lessons it holds, which become class-only. Its student data is kept.
- When a group drops to one class it is dissolved: that class gets copies too, and all its content is class-only.
- Deleting a class leaves its group first, except that its copies are deleted instead of kept.

Numbering and visibility:
- Units are ordered within the class (`class_units.position`) and lessons within their unit (the merge above). Each lesson's `number` starts at 1 and runs continuously across units in outline order. Example: Unit 1 holds lessons 1 and 2, Unit 2 holds lesson 3.
- Any create, delete, reorder, move, or link change renumbers every later lesson in each affected class, because `number` is computed on read.
- Hidden lessons (`visible = false`) keep their number. Students see the same numbers as the teacher, so gaps are possible (1, 2, 4).
- Hidden lessons are absent from the student outline, lesson page, submissions, grades, and notifications. The teacher's journal and grading still show them. Students receive only units that hold at least one visible lesson.

---

## 5. Authorization

| Group | Teacher | Student | Admin |
|---|---|---|---|
| `/health`, `/auth/*`, `/me`, `/me/password` | yes | yes | yes |
| `/categories`, `/classes` (create, edit, delete), class students, units, lessons (write), homework (write), grading, journal, AI | own classes only, `active` only | `403` | `403` |
| `/student/*` | `403` | yes | `403` |
| `GET /classes/:id/outline`, `GET /lessons/:id` | own classes | classes where the student is connected; visible lessons only | `403` |
| `GET /submissions/:id` | submissions in own classes | own submissions only (any version belonging to their class student row) | `403` |
| `POST /homeworks/:id/submissions` | `403` | connected to the class only; visible lesson only | `403` |
| `/notifications` | `403` | own | `403` |
| `/admin/*` | `403` | `403` | yes |
| `GET /files/:id` | signed URL (section 7) | signed URL | signed URL |

"Own" means `classes.teacher_id = caller`. "Connected" is defined in section 6.2. Every id in `linkedClassIds` must be one of the caller's own classes, otherwise `NOT_FOUND`. Every service method re-checks role, account state (section 2.3), and ownership or connection on the server; frontend route guards are for UX only. A `pending` teacher can reach only the always-allowed group in the first row.

---

## 6. IDs and the Connection

### 6.1 Public IDs
- Alphabet: `a-z0-9`, length 8. Generated with `crypto.randomInt`. Unique constraint plus up to 5 retries on collision.
- Display: `#XXXX-XXXX` (the frontend formats it). Stored and sent over the API without `#` or `-`.
- Normalization (applied by both sides to every input): trim, lowercase, remove `#` and `-`. Then it must match `^[a-z0-9]{8}$`, otherwise `VALIDATION_ERROR`.
- Students have a `publicId`; classes have a `publicId`; teachers have none. A student's ID is returned only to that student; a class ID only to its teacher.

### 6.2 Two-sided connection (order does not matter, no requests, no pending lists)
- Teacher side: `class_students.student_user_id` (set when the teacher enters the student's ID).
- Student side: a row in `class_claims` (created when the student enters the class ID).
- **Connected** for `(classStudent S, user U)`: `S.student_user_id = U` and a `class_claims` row `(U, S.class_id)` exists. Computed with a query, never stored.
- `connectionState` of a class student: `not_connected` (`student_user_id` is null), `awaiting_student` (set, no matching claim), `connected`.
- A student's class list contains only classes where the student is connected. Teachers never see claims; students never see roster rows.

### 6.3 Reconnect (lost account)
`PATCH /classes/:classId/students/:id` with a new `studentPublicId` replaces `student_user_id`.
- The old account loses access to the class immediately.
- The new account becomes active once it has also entered the class ID.
- All submissions and grades stay on the row.
- A `connection_audit` row records `old_user_id`, `new_user_id`, and the teacher.
- Setting `studentPublicId` to `null` disconnects the row (`not_connected`), also audited.

---

## 7. Files

- Uploaded through the endpoints in section 8; read through signed URLs.
- `FileRef.url` is `/api/v1/files/:id?exp=<unixSeconds>&sig=<hmac>` where `sig` = HMAC-SHA256 over `id:exp` with `FILE_URL_SECRET`. TTL 15 minutes. `expiresAt` mirrors `exp`.
- `GET /files/:id` needs no `Authorization` header (so `<img>`, `<iframe>`, and `fetch` for markdown work). Invalid or expired signature -> `403 FILE_URL_INVALID`. The frontend then refetches the query that produced the `FileRef`.
- Response headers: correct `Content-Type`, `Content-Length`, `Content-Disposition: inline; filename*=UTF-8''<name>`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=300`. Markdown is served as `text/plain; charset=utf-8`.
- Accepted types are validated by extension and content, not by the client-sent MIME type:

| Use | Types | Max size | Check |
|---|---|---|---|
| Lesson file, homework instructions | `.md` (`text/markdown`), `.pdf` (`application/pdf`) | `.md` 1 MB, `.pdf` 20 MB | `.md`: valid UTF-8. `.pdf`: starts with `%PDF-`. |
| Draw / math page | `image/png` | 10 MB | PNG magic bytes |
| Photo page | `image/jpeg`, `image/png`, `image/webp` | 10 MB | magic bytes |

- The frontend compresses photos client-side (canvas, JPEG) and exports draw pages as PNG before upload.
- Wrong type -> `415 UNSUPPORTED_MEDIA_TYPE`; too large -> `413 PAYLOAD_TOO_LARGE`.
- Storage sits behind a `StorageProvider` interface (`put`, `get`, `delete`). v0 implementation writes to the local directory `STORAGE_DIR`; `storage_key` is a random path that never contains user input.

---

## 8. API

Auth column: `-` public, `T` teacher, `S` student, `AD` admin, `A` any signed-in user (all three roles).

### 8.1 Health, auth, and account

| Method and path | Auth | Request | Response |
|---|---|---|---|
| `GET /health` | - | | `200 { "status": "ok" }` |
| `POST /auth/register` | - | Teacher: `{ role: 'teacher', firstName, lastName, phone, email, password, confirmPassword }`. Student: `{ role: 'student', firstName, lastName, email, password, confirmPassword }`. `role: 'admin'` is rejected. | `201 { user, accessToken }` + refresh cookie. A teacher comes back with `status: 'pending'`; a student with `status: 'active'` and a `publicId`. Errors: `EMAIL_TAKEN`, `VALIDATION_ERROR`. |
| `POST /auth/login` | - | `{ role: 'teacher' \| 'student', email, password }` | `200 { user, accessToken }` + refresh cookie. The `role` must match the account's role, otherwise `INVALID_CREDENTIALS`. A `pending` teacher can log in (the frontend shows the gate). Errors: `INVALID_CREDENTIALS`, `ACCOUNT_BLOCKED` (only after the password was correct). |
| `POST /auth/admin/login` | - | `{ login, password }` | `200 { user, accessToken }` + refresh cookie. Errors: `INVALID_CREDENTIALS`. |
| `POST /auth/refresh` | cookie | (none) | `200 { user, accessToken }` + rotated cookie. Errors: `UNAUTHENTICATED`, `ACCOUNT_BLOCKED`. |
| `POST /auth/logout` | cookie | (none) | `204`; revokes the token family, clears the cookie. |
| `GET /me` | A | | `200 User` |
| `PATCH /me` | A | `{ firstName?, lastName?, phone? }` (`phone` only for teachers) | `200 User` |
| `POST /me/password` | A | `{ currentPassword, newPassword, confirmNewPassword }` | `204`; clears `mustChangePassword` and revokes all other refresh families. Errors: `INVALID_CREDENTIALS` (wrong current password), `VALIDATION_ERROR`. |

Teacher activation:
- A new teacher is `pending`. Until an admin approves (section 8.14) every teacher endpoint returns `403 ACCOUNT_PENDING`; the frontend shows the gate "Waiting for Edunify admin approval" and polls `GET /me` every 30 seconds (and on window focus) until `status` becomes `active`.
- Students are `active` immediately. The admin account is created only by the seed script (section 11); there is no admin signup.

Password reset (no email, no SMS):
- Only an admin can reset a password (`POST /admin/users/:id/reset-password`, section 8.14). It generates a one-time temporary password, sets `mustChangePassword = true`, and revokes all of the user's sessions.
- The user logs in with the temporary password and is forced to choose a new one (`POST /me/password`) before anything else works.
- The admin passes the temporary password to the user outside the app. A student who cannot be reached can still register a new account and have the teacher reconnect the row (section 6.3).

### 8.2 Categories (T)

| Method and path | Request | Response |
|---|---|---|
| `GET /categories` | | `200 { items: Category[] }` sorted by `order` |
| `POST /categories` | `{ name }` | `201 Category`, placed last. Errors: `CATEGORY_NAME_TAKEN`, `LIMIT_REACHED`. |
| `PATCH /categories/:id` | `{ name?, order? }` (`order` = target 0-based index among the teacher's categories) | `200 Category`. Errors: `CATEGORY_NAME_TAKEN`. |
| `DELETE /categories/:id` | | `204`. Errors: `CATEGORY_NOT_EMPTY` (the category still has classes). |

### 8.3 Classes (T)

| Method and path | Request | Response |
|---|---|---|
| `GET /classes?categoryId=` | `categoryId` optional filter | `200 { items: Class[] }` sorted by category order, then class `order` |
| `POST /classes` | `{ categoryId, name }` | `201 Class` (with generated `publicId`), placed last in its category. Also creates the class's first unit, titled `Unit 1` (class-only). Errors: `LIMIT_REACHED`. |
| `GET /classes/:id` | | `200 Class` |
| `PATCH /classes/:id` | `{ categoryId?, name?, order?, linkedClassIds? }` | `200 Class`. `linkedClassIds` is the full set of other classes in the group after the save (see "Group changes"); errors `CLASS_IN_OTHER_GROUP`, `LIMIT_REACHED`, `VALIDATION_ERROR`. `order` is the target 0-based index in the category the class ends up in (the new category when `categoryId` changes, else its current one). A move to another category without `order` appends it last. The UI sends both on every drag and drop. |
| `POST /classes/:id/linked-classes/preview` | `{ linkedClassIds }` | `200 { items: GroupPreviewItem[] }`, one per affected class. Changes nothing. |
| `DELETE /classes/:id` | | `204`; cascades everything in the class; leaves its group first (section 4.1). |

Group changes (`linkedClassIds`):
- Omit it to leave the group unchanged. `[]` removes this class from its group.
- Listed classes that are not in the group join it (a new group is created if this class has none) and receive its units and linked lessons. Classes in the current group that are not listed leave it. A group left with one class is dissolved. All of it is one transaction (section 4.1).
- Preview: `added*` counts what a joining class receives; `converted*` counts units and linked lessons that become class-only in a class that leaves or in the class left alone at dissolve.

### 8.4 Class students (T)

| Method and path | Request | Response |
|---|---|---|
| `GET /classes/:classId/students` | | `200 { items: ClassStudent[] }` sorted by `fullName` |
| `POST /classes/:classId/students` | `{ fullName, studentPublicId? }` | `201 ClassStudent`. Errors: `STUDENT_ID_NOT_FOUND`, `STUDENT_ID_IN_USE` (that account already has a row in this class), `LIMIT_REACHED`. |
| `PATCH /classes/:classId/students/:id` | `{ fullName?, studentPublicId? }` (`studentPublicId: null` disconnects) | `200 ClassStudent`. Same errors; a reconnect is audited (section 6.3). |
| `DELETE /classes/:classId/students/:id` | | `204`; deletes the row with its submissions and grades. |

### 8.5 Student side: claims and classes (S)

| Method and path | Request | Response |
|---|---|---|
| `POST /student/claims` | `{ classPublicId }` | `200 { "saved": true }`. Idempotent. Always the same neutral response for an existing class, whether or not the teacher has connected the student. Errors: `CLASS_ID_NOT_FOUND`. |
| `GET /student/classes` | | `200 { items: [{ id, name, teacherName, classStudentId }] }` (connected only) sorted by name; `teacherName` is `"<firstName> <lastName>"` |

### 8.6 Outline, units, lessons

Every request in 8.6-8.9 and 8.11 addressed by a unit, lesson, or homework id takes a required `classId` query parameter (`/units/:id`, `/lessons/:id` and its sub-paths, `/lessons/:lessonId/grading`, `/lessons/:lessonId/ai-grade`, and `POST /homeworks/:homeworkId/submissions`), so placement and visibility resolve per class. A class the caller does not own or is not connected to, an item that class does not hold, or (for students) a hidden lesson returns `NOT_FOUND`.

| Method and path | Auth | Request | Response |
|---|---|---|---|
| `GET /classes/:classId/outline` | T, S | | `200 { units: Unit[], lessons: LessonSummary[] }`. Units sorted by `order`; lessons in outline order (unit order, then lesson order), each with `number`. Students get visible lessons only and only units that hold one; numbers keep their gaps. |
| `POST /classes/:classId/units` | T | `{ title }` | `201 Unit` (appended last). In a group it is the group's unit, appended last in every class of the group. Errors: `LIMIT_REACHED`. |
| `PATCH /units/:id` | T | `{ title?, order? }` (`order` = target 0-based index) | `200 Unit`. In a group `title` and `order` change in every class of the group. |
| `DELETE /units/:id` | T | | `204`. Outside a group it deletes the unit with its lessons and their submissions. In a group it deletes the unit in every class, only when no class has a lesson in it, else `UNIT_NOT_EMPTY`. Errors: `LAST_UNIT` if any affected class would be left with no unit (`details: { classIds }`). |
| `POST /classes/:classId/lessons` | T | `{ title, unitId, linked? }` (`unitId` required, a unit of this class) | `201 LessonDetail` (appended last in its unit; visible). `linked` defaults to false; `true` needs a group (else `VALIDATION_ERROR`), appends the lesson last in the unit's linked order and adds it, hidden, in every other class of the group. Errors: `LIMIT_REACHED`. |
| `GET /lessons/:id` | T, S | | `200 LessonDetail` (students also get `mySubmission`; a hidden lesson is `NOT_FOUND` for students) |
| `PATCH /lessons/:id` | T | `{ title?, unitId?, order?, linked?, visible? }` | `200 LessonDetail`. `title` of a linked lesson changes in every class. `unitId` moves a linked lesson to that unit in every class that holds it; a class-only lesson moves in its class only. `order` is the target 0-based index in this class's list of the unit the lesson ends up in (the new unit when `unitId` changes, else its current unit); for a linked lesson it sets the linked order, so it moves in every class (section 4.1, "Lesson order inside a unit"). A move to another unit without `order` appends it last. The UI sends both on every drag and drop. `visible` is this class only. `linked: false`: class-only copy in this class, at the same slot. `linked: true`: needs a group (else `VALIDATION_ERROR`); the lesson keeps its place in this class's list and is added, hidden, in every other class of the group. |
| `DELETE /lessons/:id?scope=class\|all` | T | | `204`. `scope` defaults to `class` (removes the placement and this class's submissions; a class-only lesson is deleted); `all` is only for a linked lesson and deletes it and its submissions in every class. Cascades homework and submissions in the affected classes. |
| `GET /lessons/:id/impact` | T | | `200 ContentImpact` |

### 8.7 Lesson file and homework (T)

| Method and path | Request | Response |
|---|---|---|
| `PUT /lessons/:id/lesson-file` | multipart, field `file` (`.md` or `.pdf`) | `200 LessonDetail`. Replaces any existing file. |
| `DELETE /lessons/:id/lesson-file` | | `200 LessonDetail` |
| `PUT /lessons/:id/homework` | `{ type, instructionsText? }` (creates or replaces; keeps the instructions file) | `200 LessonDetail`. Errors: `HOMEWORK_TYPE_LOCKED` (the type cannot change once any class that holds the lesson has submissions for it). |
| `PUT /lessons/:id/homework/file` | multipart, field `file` (`.md` or `.pdf`); needs an existing homework | `200 LessonDetail` |
| `DELETE /lessons/:id/homework/file` | | `200 LessonDetail` |
| `DELETE /lessons/:id/homework` | | `200 LessonDetail`; deletes its submissions and grades in every class that holds the lesson (counts from `GET /lessons/:id/impact`). |

### 8.8 Submissions

| Method and path | Auth | Request | Response |
|---|---|---|---|
| `POST /homeworks/:homeworkId/submissions` | S | By homework type. `text`: JSON `{ text }`. `code`: JSON `{ html, css, js }`. `draw`, `math`, `photo`: multipart with repeated field `pages` (1-9 files, array order = page order). | `201 Submission` (version = previous + 1, status `submitted`, grade cleared). It counts as a new homework submission for the teacher until it is graded or denied. Errors: `VALIDATION_ERROR` (content does not match the type), `LIMIT_REACHED`, `NOT_FOUND`. |
| `GET /student/submissions?classId=` | S | | `200 { items: [{ submission: Submission, lesson: { id, title }, class: { id, name } }] }`: the latest version per homework, newest first; hidden lessons are left out. |
| `GET /submissions/:id` | T, S | | `200 Submission & { versions: SubmissionVersion[] }` (versions newest first). |

### 8.9 Grading (T)

| Method and path | Request | Response |
|---|---|---|
| `GET /lessons/:lessonId/grading` | | `200 { lesson: { id, title }, homework: Homework, items: [{ classStudentId, fullName, submission: Submission \| null }] }`. Every student of the class sorted by `fullName`; `submission` is the latest version or null. Errors: `NOT_FOUND` if the lesson has no homework. |
| `PUT /submissions/:id/grade` | `{ value: 2-5, comment?, fromAi? }` or `{ denied: true, comment }` | `200 Submission` (status `graded` or `denied`). `fromAi: true` sets `source = 'ai_confirmed'` and clears `aiSuggestion`. Notifies the student (`graded` / `denied`). Errors: `SUBMISSION_NOT_LATEST`, `VALIDATION_ERROR` (both or neither of `value`/`denied`; `denied` without a comment). |
| `DELETE /submissions/:id/grade` | | `200 Submission` (status back to `submitted`, grade null). Removes the student's unread notification for it. |

Editing a grade is another `PUT` and overwrites the previous one.

### 8.10 Journal and grades

| Method and path | Auth | Response |
|---|---|---|
| `GET /classes/:classId/journal` | T | `200 { units: Unit[], columns: [{ lessonId, number, title, unitId }], rows: [{ classStudentId, fullName, connectionState, cells: JournalCell[], average: number \| null }] }` |
| `GET /student/grades` | S | `200 { items: [{ class: { id, name }, columns: [...], cells: JournalCell[], average: number \| null }] }`: one item per active class, only the caller's own cells. |

Rules:
- `columns` lists, in display order (unit order, then lesson order), only lessons that have a homework. The teacher journal includes hidden lessons; `GET /student/grades` leaves them out.
- `cells` is parallel to `columns` (same length and order). Per cell, using the student's latest submission: none -> `empty`; otherwise `submitted`, `denied` (value null), or `graded` (with `value`).
- `average` is the mean of `graded` values rounded to 2 decimals; null if there are none. Denied and empty cells are excluded. The frontend shows 1 decimal.

### 8.11 AI grading (T)

| Method and path | Request | Response |
|---|---|---|
| `POST /lessons/:lessonId/ai-grade` | `{ submissionIds?: string[] }` (omit = all latest submissions with status `submitted` of this class's students in the lesson) | `202 AiJob`. Errors: `AI_JOB_ACTIVE` (per lesson and class; details: `{ jobId }`), `VALIDATION_ERROR` (ids outside the lesson; nothing to grade), `AI_UNAVAILABLE` (no API key configured). |
| `GET /ai-jobs/:id` | | `200 AiJob` |

"AI grade" for one student sends `submissionIds: [id]`; "AI grade all" omits it.

### 8.12 Notifications (S)

| Method and path | Request | Response |
|---|---|---|
| `GET /notifications/count` | | `200 { unreadCount: number }` (for polling) |
| `GET /notifications` | | `200 { items: NotificationItem[] }`: unread only, newest first, max 100. |
| `POST /notifications/:id/read` | | `204`. Idempotent. |

Rules:
- Student: `graded` or `denied` when the teacher grades or denies. The frontend marks it read when the student opens that homework.
- Teachers have no notifications. They see `newSubmissionCount` on `Class` and on `LessonSummary` instead: one per student whose latest version for a homework has status `submitted`. It goes down when that version is graded or denied and up again on a reupload or when the grade is removed.
- At most one notification per `(user, submission)`: a later event on the same submission updates its `kind` and `createdAt` and resets `read_at` to null.
- Removing a grade deletes the student's unread notification for that submission.
- A student only sees notifications for submissions on a roster row they are connected to (section 6.2). After a reconnect the old account stops seeing them, in the count and in the list.
- A student's list and count leave out notifications for lessons hidden in that class.

### 8.13 Files

| Method and path | Auth | Response |
|---|---|---|
| `GET /files/:id?exp=&sig=` | signed URL | `200` file bytes (section 7). Errors: `FILE_URL_INVALID`, `NOT_FOUND`. |

### 8.14 Admin (AD)

| Method and path | Request | Response |
|---|---|---|
| `GET /admin/users?role=&status=&q=&limit=&offset=` | `role`: `teacher` \| `student` (optional); `status` optional; `q`: case-insensitive search in first name, last name, email, phone (optional); `limit` default 50, max 100; `offset` default 0 | `200 { items: User[], total: number }` newest first. Never includes admin accounts. |
| `PATCH /admin/users/:id/status` | `{ status: 'active' \| 'blocked' }` | `200 User`. Allowed transitions: `pending` -> `active` (approve) or `blocked` (reject); `active` -> `blocked`; `blocked` -> `active`. Blocking revokes all of the user's refresh tokens. Errors: `INVALID_STATUS_TRANSITION`, `NOT_FOUND`. |
| `POST /admin/users/:id/reset-password` | (none) | `200 { temporaryPassword: string }`. 12 characters from an unambiguous alphabet (no `0O1lI`), generated with `crypto.randomInt`. Returned only in this response and never stored in plaintext. Sets `mustChangePassword = true` and revokes all of the user's refresh tokens. |

The target of `/admin/users/:id/*` must be a teacher or a student; any other id returns `NOT_FOUND`.

---

## 9. AI Grading

- Runs entirely on the backend. The frontend only calls section 8.11 and polls `GET /ai-jobs/:id` every 2 seconds while `status` is `queued` or `running`; when it becomes `done` or `failed` the frontend refetches the grading query.
- Worker: in-process loop reading `ai_jobs`; one job at a time per process, up to 3 submissions in parallel. On server start, jobs left `running` are reset to `queued`.
- Input per submission: the lesson `.md` text (if any), the homework instructions (text or `.md`), and the submission content (text, code, or page images sent as image inputs). PDFs are not sent to the model.
- Output: strict JSON `{ "value": 2-5, "comment": string }`, validated with zod. An invalid response counts the submission as `failed` and the job continues.
- The result is stored only in `submissions.ai_suggestion`. It never changes `status` or the grade, and it is never sent to students. The teacher confirms it with `PUT /submissions/:id/grade` and `fromAi: true`.
- A new submission version clears the previous version's suggestion. Graded or denied submissions are skipped when `submissionIds` is omitted.
- Job `status` is `done` when all items were processed (even if some failed), `failed` only if the job itself could not run (`error` set).

---

## 10. Error Codes

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Invalid body, query, params, or upload content; has `details`. |
| `UNAUTHENTICATED` | 401 | Missing, invalid, or revoked credentials. |
| `TOKEN_EXPIRED` | 401 | Access token expired: refresh and retry. |
| `INVALID_CREDENTIALS` | 401 | Wrong email, password, or current password. |
| `FORBIDDEN` | 403 | The role may not use this endpoint. |
| `ACCOUNT_PENDING` | 403 | Teacher account is waiting for admin approval. |
| `ACCOUNT_BLOCKED` | 403 | Account is blocked by the admin. |
| `PASSWORD_CHANGE_REQUIRED` | 403 | The password was reset by the admin; change it first. |
| `FILE_URL_INVALID` | 403 | Signed file URL is invalid or expired. |
| `NOT_FOUND` | 404 | Does not exist or the caller cannot see it. |
| `STUDENT_ID_NOT_FOUND` | 404 | No student with that public ID. |
| `CLASS_ID_NOT_FOUND` | 404 | No class with that public ID. |
| `EMAIL_TAKEN` | 409 | Email already registered. |
| `CATEGORY_NAME_TAKEN` | 409 | Teacher already has a category with this name. |
| `CATEGORY_NOT_EMPTY` | 409 | Category still contains classes. |
| `LAST_UNIT` | 409 | A class must keep at least one unit; the deletion would leave a class with none. |
| `INVALID_STATUS_TRANSITION` | 409 | The requested account status change is not allowed. |
| `STUDENT_ID_IN_USE` | 409 | That account already has a row in this class. |
| `HOMEWORK_TYPE_LOCKED` | 409 | Type cannot change once any class holding the lesson has submissions. |
| `CLASS_IN_OTHER_GROUP` | 409 | A class in `linkedClassIds` already belongs to another group. |
| `UNIT_NOT_EMPTY` | 409 | A unit of a group can be deleted only when no class of the group has a lesson in it. |
| `SUBMISSION_NOT_LATEST` | 409 | Only the latest version can be graded. |
| `AI_JOB_ACTIVE` | 409 | A job for this lesson is already running; `details.jobId`. |
| `LIMIT_REACHED` | 409 | A cap from section 2.7 was hit; `details.classIds` for group caps. |
| `PAYLOAD_TOO_LARGE` | 413 | Body or file exceeds its limit. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | File type not allowed. |
| `RATE_LIMITED` | 429 | Too many requests. |
| `AI_UNAVAILABLE` | 503 | AI grading is not configured. |
| `INTERNAL` | 500 | Unexpected error; details only in server logs. |

---

## 11. Configuration and Deployment

Backend environment variables (validated with zod at startup; the process exits on any missing or invalid value):

| Variable | Meaning |
|---|---|
| `NODE_ENV` | `development` \| `production` \| `test` |
| `PORT` | HTTP port, default 3000 |
| `DATABASE_URL` | PostgreSQL connection string |
| `JWT_ACCESS_SECRET` | min 32 characters |
| `FILE_URL_SECRET` | min 32 characters, different from the JWT secret |
| `STORAGE_DIR` | absolute path for uploaded files |
| `ANTHROPIC_API_KEY` | optional; without it `AI_UNAVAILABLE` is returned |
| `AI_MODEL` | model id used for AI grading |

Admin seed (not read by the server at runtime): `npm run seed:admin` reads `ADMIN_LOGIN` (default `edunify_admin`) and `ADMIN_PASSWORD` (min 12 characters, required) and creates the admin user (`role = 'admin'`, `status = 'active'`) if none exists. It never overwrites an existing admin; `npm run seed:admin -- --reset-password` replaces the admin's password with `ADMIN_PASSWORD`.

Frontend: no environment variables; it always calls the relative path `/api/v1`.

Development: Vite dev server proxies `/api` to the backend, so cookies and file URLs behave as in production. Production: one origin behind a reverse proxy with HTTPS.

Backend folders:

```
src/
  config/        env.ts
  db/            models/, migrations/, index.ts
  middleware/    auth.ts, role.ts, error.ts, rateLimit.ts, upload.ts
  modules/       auth/, categories/, classes/, groups/, students/, lessons/, submissions/, grading/, journal/, notifications/, files/, ai/
                 (each: routes.ts, service.ts, schemas.ts)
  storage/       provider.ts, local.ts
  jobs/          aiWorker.ts
  lib/           publicId.ts, tokens.ts, signedUrl.ts
  app.ts, server.ts
```

Route handlers parse input with zod, call a service, and return DTOs; services hold all authorization and business rules; only services touch Sequelize models.

---

## 12. Change Rules

- API change: edit this file first (endpoint, DTO, error code), then backend, then the frontend service and its zod schema, then the mock.
- A backward-incompatible change to an existing field or endpoint needs `/api/v2`.
- New error code: add it to section 10 and to the frontend `errors.<code>` i18n key in the same change.
- New dependency on either side: needs approval and an update to section 1.

---

## 13. Out of Scope (v0)

- Email or SMS delivery of any kind: no verification, no reset links (resets are admin-issued).
- Teachers resetting their students' passwords; admin management of other admins (there is exactly one, seeded).
- Leaving a class from the student side; deleting or editing a student's own submissions.
- Pagination, search, and exports.
- Due dates, attendance, classwork grades, parent accounts, admin role.
- WebSockets and push notifications.
- Languages other than `en` (error `code`s already make the API language-neutral).
