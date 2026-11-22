# Edunify: Technical Specification

Status: v1 (frontend-focused; backend described for contract parity only). Everything below is a decision, not a proposal.

## 1. Overview

Edunify is a browser-only web app for school classes.
- **Teachers** create categories and classes, keep a homework journal, publish lessons and homework, and grade submissions (manually or with AI).
- **Students** join classes, read lessons, submit homework, and see grades.

Not in scope: native apps, WebSockets, offline mode, real-time collaboration.

## 2. Platform Requirements

| Area | Requirement |
|---|---|
| Platform | Web, browser only |
| Languages | v0: `en` only, no language switcher. All strings still go through i18next so `ru` and `uz` (Latin script) can be added later by adding a locale file and a switcher. |
| Themes | Light and dark. Always opens in the system preference; the toggle only switches between light and dark and is not persisted. No flash on load (inline script sets `data-theme` before paint). |
| Responsive | Mobile `<768px` (min width 360), tablet `768-1023`, laptop `1024-1535`, PC `>=1536`. Tailwind breakpoints: `md`=768, `lg`=1024, `2xl`=1536. |
| Formatting | Dates/numbers via `Intl` using the active language (`en` in v0). User content (lessons, comments, homework) is never translated. |

## 3. Stack (strict: no additions without approval)

| Area | Package (major) |
|---|---|
| Build | Vite 8 + `@vitejs/plugin-react` 6, npm |
| Language | TypeScript **~6.0** (not 7: typescript-eslint and react-i18next don't support it yet), `strict`, `.ts`/`.tsx` only |
| UI | React 19 (functional + hooks; only class component: top-level `ErrorBoundary`) |
| Routing | React Router 7 (`react-router`, `createBrowserRouter` + lazy routes). Not v8 |
| Server state | TanStack React Query 5 |
| Client state | Zustand 5 |
| HTTP | Axios 1, one instance in `src/services/api.ts`, used only by services |
| Validation | zod 4 |
| Styling | Tailwind CSS 4 via `@tailwindcss/vite` (no config file) |
| Icons | lucide-react 1 |
| i18n | i18next 26 + react-i18next 17 |
| Markdown | `react-markdown` + `remark-gfm` (approved). Raw HTML disabled. |
| Toolchain types | `typescript`, `@types/react`, `@types/react-dom`, `tailwindcss` (peer of `@tailwindcss/vite`) |
| Mock data | `@faker-js/faker` 10 (devDependency), only inside `src/services/mocks/` |
| Lint | ESLint 10 + typescript-eslint 8 + `eslint-plugin-react-hooks` + `eslint-plugin-react-refresh` (`eslint.config.ts` via `jiti`) |

Rules:
- npm scripts: `dev`, `build`, `lint`, `typecheck`.
- Exact versions live in `package.json`; never upgrade a major without asking.
- NO Redux, GraphQL, WebSockets, other UI/state/form libraries. Context only for providers (router, query client).
- No form library: controlled components + zod `safeParse`.
- PDF viewing: native `<iframe>`/`<object>`, with an "Open / download" fallback button (mobile browsers).
- Drawing: native `<canvas>` + Pointer Events (touch, mouse, stylus).
- Code input: native `<textarea>`, no editor library.
- Tests: none for now (no runner in stack). Deferred; adding Vitest requires approval.
- Backend (parity context): Node + Express + Sequelize + PostgreSQL, JWT (`Authorization: Bearer`), REST.

## 4. Code Conventions

```
src/
  app/            router, providers, ErrorBoundary, layouts
  pages/          route components (lazy-loaded), one folder per route
  features/       feature modules (classes, journal, lessons, homework, grading, notifications)
                  each: components/, hooks/, schemas.ts, types.ts
  components/     shared UI (Button, Modal, Drawer, Table, Empty/Error/Loading states)
  services/       api.ts (axios instance), one file per resource, mocks/
  stores/         Zustand stores (auth, theme, sidebar)
  i18n/           index.ts, locales/en.json
  lib/            pure helpers (id, grades, files, canvas)
```

- Components: `PascalCase.tsx`; hooks: `useX.ts`; everything else `camelCase.ts`.
- Every route is lazy-loaded. One top-level `ErrorBoundary`.
- Every list/query has loading, empty and error states.
- All user-visible strings go through i18n; no hard-coded text.
- Zustand is used only for: auth session, theme, sidebar state. Everything else is React Query.
- Axios is touched only inside `src/services/`. Components call hooks, hooks call services.
- Every API response is parsed with zod in the service layer.
- Frontend is built against `src/services/mocks/` first; the service layer switches to the real API without changing hooks.

## 5. Domain Model

```
User            id, role('teacher'|'student'|'admin'), firstName, lastName, email?, phone? (teachers), login? (admin), passwordHash, status('pending'|'active'|'blocked'), mustChangePassword, publicId (students only), createdAt
Category        id, teacherId, name                       (free, teacher-defined)
Class           id, categoryId, name, publicId (#XXXX-XXXX), groupId?
ClassGroup      id                                                   <- a teacher's linked classes (2-10)
ClassStudent    id, classId, fullName, studentUserId?(nullable)      <- the enrollment row
ClassClaim      id, studentUserId, classId                           <- student side of handshake (private)
Unit            id, title, owner (one class, or the group when the class is in one)
ClassUnit       classId, unitId, order                               <- placement of a unit in a class (same order in a whole group)
Lesson          id, unitId, title, owner (one class = class-only, or a group = linked), linkedOrder?, lessonFile?, homework?
ClassLesson     classId, lessonId, slot?, visible                    <- placement of a lesson in a class (slot: class-only only)
Homework        id, lessonId, type('text'|'draw'|'math'|'code'|'photo'), instructionsText?, instructionsFile?
Submission      id, homeworkId, classStudentId, version, status, content, createdAt
Grade           id, submissionId, value(2..5)|null, denied(bool), comment, gradedBy('teacher'|'ai-confirmed'), updatedAt
Notification    id, userId, kind('graded'|'denied'), submissionId, readAt?      <- students only
```

Key rule: **grades and submissions belong to `ClassStudent`, not to the account.** This is what lets a student recover history after losing an account (see 6.3).

Only lessons are linked; units are never linked. In a group every class has the same units in the same order. Linked lessons are shared by every class of the group with one linked order; class-only lessons keep their own slot in their class, and visibility is per class. A lesson's number is computed by the server from the order and never stored (C §4.1).

Unique constraints: `ClassStudent(classId, studentUserId)` (a student appears once per class), `ClassClaim(studentUserId, classId)`, `User.publicId`, `Class.publicId`.

## 6. Public IDs and the Connection (Handshake)

### 6.1 ID format
- Display: `#XXXX-XXXX`. Stored: 8 characters, lowercase letters + digits, no `#` or `-`.
- Random generation on the server, DB unique constraint, retry on collision.
- Input is normalized: trim, lowercase, strip `#` and `-`, then validate `/^[a-z0-9]{8}$/`.
- Students have a public ID. Classes have a public ID. Teachers have none.
- A student's ID is visible only to that student; a class ID only to its teacher.

### 6.2 Handshake
There are two independent actions, and **order does not matter**. There are no requests, no pending lists, and no approvals.

| Side | Action | Stored as |
|---|---|---|
| Teacher | Enters the student's ID on a `ClassStudent` row (when adding the student, or later by editing) | `ClassStudent.studentUserId` |
| Student | Enters the class ID in "Connect to class" | `ClassClaim(studentUserId, classId)` |

The student is **connected** only when a row has `studentUserId = S` AND a claim exists for `(S, thatClass)`. Active is computed on the server.

Row states shown to the teacher: "Not connected" (no student ID entered), "Awaiting student" (ID entered, no matching claim), "Connected".
The teacher never sees claims; the student never sees rows. A student's class list contains only **connected** classes.

Student feedback after entering a class ID: a neutral message ("Saved. The class will appear here once your teacher connects you."). It does not reveal whether a row exists.

Errors:
- Teacher enters an ID that matches no student: "No student with this ID".
- Student enters an ID that matches no class: "No class with this ID".
- Teacher enters an ID already used by another row in the same class: rejected.
- Rate-limit ID lookups on the backend to prevent enumeration.

### 6.3 Account recovery / reconnect
If a student loses their account and signs up again, they get a new ID. The teacher edits the same row and enters the new ID.
- The old account **loses access immediately**.
- The new account gets access once it has also entered the class ID (the same handshake).
- All history (submissions, grades) stays on the row.
- The change is written to an audit log.

## 7. Auth and Roles

Three roles, one per account: `teacher`, `student`, `admin`. Field-level rules and endpoints are in `docs/contract.md`.

### 7.1 Forms (all fields required)

| Screen | Fields |
|---|---|
| Teacher signup | name, surname, phone number, email, password, confirm password |
| Teacher login | email, password |
| Student signup | name, surname, email, password, confirm password |
| Student login | email, password |
| Admin login (no signup) | login, password |

- Signup never verifies the email or the phone: no confirmation emails, SMS, or codes anywhere.
- The client validates with zod (matching passwords, phone format with `+`, email) before sending; server errors are shown next to the field by `details[].path`.
- Login screen has a Teacher / Student switch; the admin login is a separate route that is not linked from public pages.

### 7.2 Teacher activation gate
- After signup or login a teacher with `status: 'pending'` sees only a full-page gate: "Waiting for Edunify admin approval" and a Log out button. No navigation, no other routes.
- The gate refetches `GET /me` every 30 seconds and on window focus; when `status` becomes `active` it redirects to `/teacher`.
- `403 ACCOUNT_PENDING` from any call also routes to the gate. `403 ACCOUNT_BLOCKED` logs the user out and shows "Your account is blocked".
- Students have no gate.

### 7.3 Password reset (admin-issued)
- There is no self-service reset and no email. A user who forgot a password asks the admin.
- The admin generates a temporary password (shown once, with a Copy button). The user logs in with it and is sent to a forced "Set new password" screen (`mustChangePassword`); every other route is blocked until it is changed.
- Any logged-in user can change their own password from the profile menu.

### 7.4 Admin area
- Seeded account only (`edunify_admin` by default); there is no signup.
- `/admin`: a users table with tabs Pending / Active / Blocked, a role filter (teacher, student), a search box (name, email, phone), and server-side pagination.
- Row actions: Approve and Reject (pending), Block (active), Unblock (blocked), Reset password. Reject, Block, and Reset password need a confirmation.
- The admin sees no classes, lessons, or student work.

### 7.5 Session
- Auth is JWT, sent as `Authorization: Bearer`.
- Token storage: access token in memory only (Zustand auth store, never `localStorage`); refresh token in an httpOnly, Secure, SameSite cookie. On app load the client calls `POST /auth/refresh` to restore the session. Axios uses `withCredentials: true`.
- Axios interceptor: on 401 `TOKEN_EXPIRED` refresh once and retry, otherwise clear the session and redirect to login.
- Route guards by role and status: teacher routes need `role = teacher` and `status = active`; student routes need `role = student`; `/admin` needs `role = admin`.
- The server enforces all authorization; the client checks are for UX only.

## 8. Teacher Flows

### 8.1 Home
- Home (`/teacher`) has no side panel and no header chrome: the logo and name, the title "Classes" in the middle, and on the right a menu button (Profile, Switch theme, Log out) and a plus button (New category, New class).
- Categories are teacher-defined and shown as full-height columns side by side, separated by a gray line; classes are stacked in each column as bordered cards showing the count of new homework submissions (accent background, left of the class name; nothing when it is 0), the class name, a settings icon button, and a menu with only the move actions. Add / rename / delete a category (delete confirmation). Deleting a category that still has classes is rejected (`CATEGORY_NOT_EMPTY`).
- A grab handle on each category moves it left or right, and a grab handle on each class moves it within its category or to another one (native HTML5 drag and drop, no library). The order is saved (`order`, C §8.2-8.3). Menu actions (move left, move right for categories; move up, move down for classes) do the same without a pointer, so every move also works by keyboard and on touch. Moving a class to another category without a pointer is done in class settings.
- Add class: pick a category, enter the name (required). The class gets its public ID (shown to the teacher, copyable). There is no subject.
- **Class settings** (modal opened by the settings icon on the card):
  - Fields: name, category.
  - Heading "Linked classes" with an "Add" button. "Add" opens a picker of the teacher's other classes; classes already in another group are disabled with a reason.
  - Below it, the list of linked classes, each with a remove button.
  - Footer: "Delete class" (danger, with confirmation), "Cancel", "Save".
  - Group changes apply on Save, after a confirmation that summarizes what will be added to or converted in each class (C §8.3 preview).
- Add student to a class: **Full name (required)** and **Student ID (optional)**. The ID can be added or edited later.
- Edit / remove a student row.

### 8.2 Class view
- Left side panel, togglable (drawer on mobile). Top item: **Homework Journal**, followed by units and lessons.
- Every lesson sits in a unit; a lesson can only be created inside a unit. A new class starts with one unit, "Unit 1", and a class always keeps at least one unit (the last one cannot be deleted). A class with no units would show "Create a unit first".
- Numbering: each lesson shows its number as a prefix ("3. Fractions") in the outline and on lesson pages. Numbers run continuously across units, are computed by the server, and are never typed. Hidden lessons keep their number.
- Add / edit / remove a unit. Add / edit / remove a lesson (a lesson is added into a chosen unit).
- Units have no Linked toggle. In a group, adding, renaming, moving, or deleting a unit does it in every class of the group. A unit that is empty in a class (its lessons are in other classes only) still shows for the teacher and is hidden from students.
- The add lesson dialog has a "Linked with other classes" toggle, shown only when the class is in a group and on by default.
- Lesson settings (per class, from the lesson's menu in the side panel):
  - "Visible to students" toggle. Hidden lessons are absent from the student outline, lesson page, submissions, and grades; the journal still shows them.
  - "Linked" toggle, shown only when the class is in a group. Turning it off makes a class-only copy in this class. Turning it on adds the lesson to every class of the group, hidden there. The homework type is locked if any class in the group has submissions for it.
- Markers in the side panel: an Unlink icon on an unlinked lesson, shown only when the class is in a group (tooltip and aria-label "Unlinked lesson"); an EyeOff icon on a lesson hidden from students ("Hidden from students"). A lesson can show both. There is no legend or note.
- New homework submissions: a lesson shows its count on an accent background on the left of the lesson name (nothing when it is 0; tooltip and aria-label "N new homework submissions"). The count is the students whose latest submission is not graded or denied yet. It is polled every 45 s and on window focus, here and on the class cards (section 8.1).
- Lessons are reordered and moved to another unit by drag and drop in the side panel (native HTML5 drag and drop, no library). Menu actions (move up, move down, move to a unit) do the same without a pointer, so every move also works by keyboard and on touch. Moving a linked lesson moves it in every class of the group (one linked order, C §4.1); moving a class-only lesson changes this class only.
- Deleting a unit needs a confirmation. Outside a group it cascades to its lessons. In a group it deletes the unit in every class and is refused while any class has a lesson in it ("Move or delete its lessons in every linked class first").
- Deleting a class-only lesson needs a confirmation and cascades. Deleting a linked lesson opens a dialog with "Remove from this class only" and "Delete from all linked classes"; the second lists each class with its submission count.

### 8.3 Homework Journal
- Students are listed vertically; lessons that have a homework (hidden ones too) are listed horizontally in order, grouped under unit headers. Each column header shows only the lesson number; the tooltip shows the full "3. Fractions".
- One cell = one lesson's homework grade for that student. **No dates, no attendance.**
- Cell states: empty (not submitted), submitted (ungraded), denied, graded (shows 2-5).
- Last column: average of numeric grades (1 decimal). Denied and empty are excluded.
- The student column is sticky; the table scrolls horizontally on small screens.
- Clicking a cell opens that student's submission in grading.

### 8.4 Lesson (three sections)
1. **Lesson**: upload a `.md` or `.pdf`. Replace / remove. `.md` is rendered with `react-markdown`; `.pdf` is shown natively.
2. **Homework**: instructions as an `.md`/`.pdf` upload or a plain textarea. Choose the homework type (see 10). Edit / remove.
3. **Grading Homework** (see 8.5).

### 8.5 Grading Homework
- Left: list of students (with state). Opens on the first student with a submission.
- Main area: the student's submission. Multi-page submissions scroll horizontally.
- Bottom bar: comment input; grade buttons **2, 3, 4, 5**; **Deny** (return for redo; a comment is required); **Next** (moves to the next student); **AI grade**; **AI grade all**.
- Grades and comments can be edited or removed afterward.
- Saving a grade or a deny creates a notification (`graded` / `denied`) for the student.
- Teachers get no notifications and have no bell. A new or re-uploaded submission raises the count of new homework submissions on its lesson and its class (sections 8.1 and 8.2); grading or denying it lowers the count.

### 8.6 AI grading
- Frontend only calls the backend; the backend calls the model (a vision model for draw/photo).
- AI **only prefills** the grade and comment. The teacher must confirm before it counts.
- "AI grade all" starts a backend job; the UI polls status with React Query `refetchInterval` (no WebSockets) and shows progress; prefilled results are marked "AI suggestion" until confirmed.
- Rate limits and cost controls live on the backend.

## 9. Student Flows

### 9.1 Home
- **Choose class**: list of active classes. **Connect to class**: input for a class ID (see 6.2).
- Navigation: Classes, My uploaded homeworks, Graded Homeworks (with badge), My homework Grades.

### 9.2 Class
- Choose a class, then a lesson. The outline shows "N. Title" for visible lessons only, so numbers can have gaps (1, 2, 4); units without a visible lesson are absent. See the lesson content and the homework, then submit.
- Submission UI depends on the homework type (see 10).

### 9.3 My uploaded homeworks
- All of the student's submissions with their status, grade and comment.
- Reupload / redo: **versions are kept**; the newest version is the one graded. A reupload resets the status to "submitted" and clears the active grade (old versions keep theirs in history).

### 9.4 Graded Homeworks (notifications)
- Red dot with a count on the nav item.
- Contains only notifications of graded or denied homeworks.
- Clicking one opens that homework in "My uploaded homeworks" and **removes the notification** (marked read).
- The count is polled every 45 s and on window focus.

### 9.5 My homework Grades
- Classes listed vertically, grades horizontally (one cell per visible lesson, number-only headers under unit headers with the full "N. Title" tooltip, no dates), with an average.

## 10. Homework Types

| Type | Student input | Stored as |
|---|---|---|
| Text | Textarea (phone keyboard) | text |
| Draw | Canvas, up to **9 pages** | one PNG per page |
| Math | **Same as Draw for now** (a dedicated math input comes later) | one PNG per page |
| Code | Three tabs/boxes: **HTML, CSS, JS**; Tab key inserts indentation | three text fields |
| Photo | Image upload, up to **9 pages** | images |

Notes:
- The teacher chooses one type per homework.
- Draw: pen colors/sizes, eraser, undo, clear page, add/remove page. Pointer Events handle touch, mouse and stylus; pages are exported to PNG.
- Code: the teacher sees a live preview in a **sandboxed iframe** (`sandbox="allow-scripts"`, without `allow-same-origin`). No server-side execution.
- Photo: images are compressed client-side through canvas before upload.
- Math type is shown in the UI but uses the Draw component.

## 11. Files and Limits

| Item | Limit |
|---|---|
| Lesson / homework `.md` | 1 MB |
| Lesson / homework `.pdf` | 20 MB |
| Images (photo/draw page) | 10 MB each, max 9 per submission |

- Validate the MIME type and size on both client and server.
- File storage is the backend's concern. The frontend only uploads via multipart requests and uses the URLs returned by the API.
- Rendered markdown has raw HTML disabled.

## 12. Routes (React Router 7, lazy)

```
/                             redirects to /login
/login                        Teacher | Student switch
/register/teacher, /register/student
/admin/login                  admin only, not linked publicly
/admin                        users: approve, reject, block, reset password
/waiting                      teacher activation gate
/change-password              forced after an admin reset
/teacher                      categories + classes (home, no side panel)
/teacher/profile              profile: details, Edit, Change password
/teacher/classes/:classId     class view (side panel)
  /journal
  /lessons/:lessonId          lesson | homework | grading
/student                      choose class + connect to class
/student/classes/:classId/lessons/:lessonId
/student/submissions          My uploaded homeworks
/student/graded               Graded Homeworks (notifications)
/student/grades               My homework Grades
*                             not found
```

## 13. API Contract

The full API (endpoints, DTOs, errors, auth, limits, files) is defined in `docs/contract.md`. That file wins on anything about the API and data.

## 14. UI / UX Rules

- Mobile-first Tailwind. Layouts adapt as follows: mobile = single column + drawer, tablet/laptop/PC = collapsible side panel.
- Dark mode via `data-theme`. Use semantic color tokens; no hard-coded colors in components.
- Minimum 44 px touch targets on mobile.
- Icons: `lucide-react` only.
- Destructive actions (delete category/class/unit/lesson/student, remove grade) always need a confirmation.
- Accessibility: keyboard navigation for the journal and grading, visible focus, labels on inputs.

## 15. Security

- Sanitize everything rendered from user content (markdown with HTML disabled; code preview sandboxed).
- Never trust IDs from the client: the server enforces the handshake, ownership and role checks.
- Rate-limit login and public-ID lookups.
- No secrets in the frontend bundle.

## 16. Deferred / Out of Scope (v1)

- `ru` and `uz` languages and the language switcher (i18n is wired for them; only `en.json` exists in v0).
- Dedicated Math input (currently = Draw).
- Due dates, late status, attendance, classwork grades.
- Teacher-side pending/request flow (explicitly not wanted).
- Automated tests.
- Offline mode, push notifications, real-time updates.

## 17. Development Order

1. Scaffold the project with the stack in section 3 and the folder layout in section 4.
2. Build every feature against `src/services/mocks/` first. Hooks and components never know whether a service is mocked.
3. Switch each service to the real API by changing only its service file; zod schemas stay the same.
