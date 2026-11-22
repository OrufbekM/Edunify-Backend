import { QueryTypes, type Transaction } from 'sequelize';

import { sequelize } from '../../db/index.js';
import type { NotificationKind } from '../../db/models/enums.js';
import { Notification } from '../../db/models/index.js';
import { AppError } from '../../lib/errors.js';

const LIST_LIMIT = 100;

export interface NotificationItemDto {
  id: string;
  kind: NotificationKind;
  submissionId: string;
  lessonId: string;
  classId: string;
  lessonTitle: string;
  className: string;
  createdAt: string;
}

// Students only: graded or denied, when the teacher grades or denies (contract 8.12). At most
// one per (user, submission): a later event updates its kind and createdAt and makes it
// unread again.
export async function notify(
  userId: string,
  submissionId: string,
  kind: NotificationKind,
  transaction?: Transaction,
): Promise<void> {
  await sequelize.query(
    `INSERT INTO notifications (user_id, submission_id, kind)
     VALUES ($userId, $submissionId, $kind)
     ON CONFLICT (user_id, submission_id)
     DO UPDATE SET kind = EXCLUDED.kind, created_at = now(), updated_at = now(), read_at = NULL`,
    { bind: { userId, submissionId, kind }, transaction },
  );
}

// Removing a grade takes back the unread notice for it (contract 8.12), from whichever
// account got it: the row may have been reconnected since. Read ones stay.
export async function removeUnreadGradeNotices(
  submissionId: string,
  transaction?: Transaction,
): Promise<void> {
  await Notification.destroy({ where: { submissionId, readAt: null }, transaction });
}

// Unread, and about a submission the student can still open (contract 8.12): on a roster row
// connected to them (contract 6.2), for a lesson the class shows. A student reconnected away
// from a row stops seeing its notifications, as they stop seeing the class (contract 6.3);
// hiding the lesson takes them out of the list and the count until it is shown again.
const UNREAD_FOR_USER = `
     FROM notifications n
     JOIN submissions s ON s.id = n.submission_id
     JOIN class_students cs ON cs.id = s.class_student_id AND cs.student_user_id = n.user_id
     JOIN homeworks h ON h.id = s.homework_id
     JOIN lessons l ON l.id = h.lesson_id
     JOIN classes c ON c.id = cs.class_id
     JOIN class_lessons cl ON cl.class_id = cs.class_id AND cl.lesson_id = l.id AND cl.visible
    WHERE n.user_id = $userId
      AND n.read_at IS NULL
      AND EXISTS (SELECT 1 FROM class_claims cc
                   WHERE cc.student_user_id = cs.student_user_id
                     AND cc.class_id = cs.class_id)`;

export async function countUnread(userId: string): Promise<number> {
  const [row] = await sequelize.query<{ unreadCount: number }>(
    `SELECT count(*)::int AS "unreadCount" ${UNREAD_FOR_USER}`,
    { bind: { userId }, type: QueryTypes.SELECT },
  );

  return row?.unreadCount ?? 0;
}

// Newest first, at most 100 (contract 8.12).
export async function listUnread(userId: string): Promise<NotificationItemDto[]> {
  const rows = await sequelize.query<Omit<NotificationItemDto, 'createdAt'> & { createdAt: Date }>(
    `SELECT n.id,
            n.kind,
            n.submission_id AS "submissionId",
            l.id AS "lessonId",
            c.id AS "classId",
            l.title AS "lessonTitle",
            c.name AS "className",
            n.created_at AS "createdAt"
       ${UNREAD_FOR_USER}
      ORDER BY n.created_at DESC, n.id DESC
      LIMIT ${LIST_LIMIT}`,
    { bind: { userId }, type: QueryTypes.SELECT },
  );

  return rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
}

// Idempotent: marking a read notification again changes nothing (contract 8.12).
export async function markRead(userId: string, notificationId: string): Promise<void> {
  const notification = await Notification.findOne({ where: { id: notificationId, userId } });

  if (!notification) {
    throw new AppError('NOT_FOUND', 'Notification not found');
  }

  if (notification.readAt === null) {
    await notification.update({ readAt: new Date() });
  }
}
