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
  classSubject: string;
  className: string | null;
  studentName: string | null;
  createdAt: string;
}

// At most one per (user, submission): a later event updates its kind and createdAt and makes
// it unread again (contract 8.12).
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

export async function removeUnread(
  userId: string,
  submissionId: string,
  transaction?: Transaction,
): Promise<void> {
  await Notification.destroy({ where: { userId, submissionId, readAt: null }, transaction });
}

// Removing a grade takes back the unread graded or denied notice for it (contract 8.12),
// from whichever account got it: the row may have been re-linked since. Read ones stay,
// and so does the teacher's own submitted notice.
export async function removeUnreadGradeNotices(
  submissionId: string,
  transaction?: Transaction,
): Promise<void> {
  await Notification.destroy({
    where: { submissionId, readAt: null, kind: ['graded', 'denied'] },
    transaction,
  });
}

// Unread, and about a submission the user can still open: in a class they teach, or on a
// roster row actively linked to them. A student re-linked away from a row stops seeing its
// notifications, as they stop seeing the class (contract 6.3).
const UNREAD_FOR_USER = `
     FROM notifications n
     JOIN submissions s ON s.id = n.submission_id
     JOIN class_students cs ON cs.id = s.class_student_id
     JOIN homeworks h ON h.id = s.homework_id
     JOIN lessons l ON l.id = h.lesson_id
     JOIN classes c ON c.id = l.class_id
    WHERE n.user_id = $userId
      AND n.read_at IS NULL
      AND (c.teacher_id = n.user_id
           OR (cs.student_user_id = n.user_id
               AND EXISTS (SELECT 1 FROM class_claims cc
                            WHERE cc.student_user_id = cs.student_user_id
                              AND cc.class_id = cs.class_id)))`;

export async function countUnread(userId: string): Promise<number> {
  const [row] = await sequelize.query<{ unreadCount: number }>(
    `SELECT count(*)::int AS "unreadCount" ${UNREAD_FOR_USER}`,
    { bind: { userId }, type: QueryTypes.SELECT },
  );

  return row?.unreadCount ?? 0;
}

// studentName is the name on the teacher's roster, and only on a teacher's 'submitted' item.
export async function listUnread(userId: string): Promise<NotificationItemDto[]> {
  const rows = await sequelize.query<Omit<NotificationItemDto, 'createdAt'> & { createdAt: Date }>(
    `SELECT n.id,
            n.kind,
            n.submission_id AS "submissionId",
            l.id AS "lessonId",
            c.id AS "classId",
            l.title AS "lessonTitle",
            c.subject AS "classSubject",
            c.name AS "className",
            CASE WHEN n.kind = 'submitted' AND c.teacher_id = n.user_id
                 THEN cs.full_name END AS "studentName",
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
