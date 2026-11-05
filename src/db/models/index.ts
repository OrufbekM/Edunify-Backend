import { AiJob } from './AiJob.js';
import { Category } from './Category.js';
import { ClassClaim } from './ClassClaim.js';
import { ClassStudent } from './ClassStudent.js';
import { FileRecord } from './FileRecord.js';
import { Homework } from './Homework.js';
import { Lesson } from './Lesson.js';
import { LinkAudit } from './LinkAudit.js';
import { Notification } from './Notification.js';
import { RefreshToken } from './RefreshToken.js';
import { SchoolClass } from './SchoolClass.js';
import { Submission } from './Submission.js';
import { SubmissionPage } from './SubmissionPage.js';
import { Unit } from './Unit.js';
import { User } from './User.js';

// Associations mirror the foreign keys and ON DELETE rules of the migrations.
// The database enforces them; these only add query helpers, since nothing calls sync().

// users
User.hasMany(RefreshToken, { foreignKey: 'userId', onDelete: 'CASCADE' });
RefreshToken.belongsTo(User, { foreignKey: 'userId' });

User.hasMany(Category, { foreignKey: 'teacherId' });
Category.belongsTo(User, { foreignKey: 'teacherId', as: 'teacher' });

User.hasMany(FileRecord, { foreignKey: 'ownerUserId' });
FileRecord.belongsTo(User, { foreignKey: 'ownerUserId', as: 'owner' });

// categories and classes
Category.hasMany(SchoolClass, { foreignKey: 'categoryId', onDelete: 'RESTRICT' });
SchoolClass.belongsTo(Category, { foreignKey: 'categoryId' });

User.hasMany(SchoolClass, { foreignKey: 'teacherId' });
SchoolClass.belongsTo(User, { foreignKey: 'teacherId', as: 'teacher' });

// the link (contract section 6)
SchoolClass.hasMany(ClassStudent, { foreignKey: 'classId', onDelete: 'CASCADE' });
ClassStudent.belongsTo(SchoolClass, { foreignKey: 'classId' });

User.hasMany(ClassStudent, { foreignKey: 'studentUserId', onDelete: 'SET NULL' });
ClassStudent.belongsTo(User, { foreignKey: 'studentUserId', as: 'studentUser' });

User.hasMany(ClassClaim, { foreignKey: 'studentUserId', onDelete: 'CASCADE' });
ClassClaim.belongsTo(User, { foreignKey: 'studentUserId', as: 'studentUser' });

SchoolClass.hasMany(ClassClaim, { foreignKey: 'classId', onDelete: 'CASCADE' });
ClassClaim.belongsTo(SchoolClass, { foreignKey: 'classId' });

ClassStudent.hasMany(LinkAudit, { foreignKey: 'classStudentId', onDelete: 'CASCADE' });
LinkAudit.belongsTo(ClassStudent, { foreignKey: 'classStudentId' });
// old_user_id and new_user_id carry no foreign key, so they get no association.
LinkAudit.belongsTo(User, { foreignKey: 'changedBy', as: 'changedByUser' });

// outline
SchoolClass.hasMany(Unit, { foreignKey: 'classId', onDelete: 'CASCADE' });
Unit.belongsTo(SchoolClass, { foreignKey: 'classId' });

SchoolClass.hasMany(Lesson, { foreignKey: 'classId', onDelete: 'CASCADE' });
Lesson.belongsTo(SchoolClass, { foreignKey: 'classId' });

Unit.hasMany(Lesson, { foreignKey: 'unitId', onDelete: 'CASCADE' });
Lesson.belongsTo(Unit, { foreignKey: 'unitId' });

Lesson.belongsTo(FileRecord, { foreignKey: 'lessonFileId', as: 'lessonFile' });

// homework
Lesson.hasOne(Homework, { foreignKey: 'lessonId', onDelete: 'CASCADE' });
Homework.belongsTo(Lesson, { foreignKey: 'lessonId' });
Homework.belongsTo(FileRecord, { foreignKey: 'instructionsFileId', as: 'instructionsFile' });

// submissions
Homework.hasMany(Submission, { foreignKey: 'homeworkId', onDelete: 'CASCADE' });
Submission.belongsTo(Homework, { foreignKey: 'homeworkId' });

ClassStudent.hasMany(Submission, { foreignKey: 'classStudentId', onDelete: 'CASCADE' });
Submission.belongsTo(ClassStudent, { foreignKey: 'classStudentId' });

Submission.hasMany(SubmissionPage, { foreignKey: 'submissionId', onDelete: 'CASCADE', as: 'pages' });
SubmissionPage.belongsTo(Submission, { foreignKey: 'submissionId' });
SubmissionPage.belongsTo(FileRecord, { foreignKey: 'fileId', as: 'file' });

// notifications
User.hasMany(Notification, { foreignKey: 'userId', onDelete: 'CASCADE' });
Notification.belongsTo(User, { foreignKey: 'userId' });

Submission.hasMany(Notification, { foreignKey: 'submissionId', onDelete: 'CASCADE' });
Notification.belongsTo(Submission, { foreignKey: 'submissionId' });

// AI grading
Lesson.hasMany(AiJob, { foreignKey: 'lessonId', onDelete: 'CASCADE' });
AiJob.belongsTo(Lesson, { foreignKey: 'lessonId' });
AiJob.belongsTo(User, { foreignKey: 'createdBy', as: 'creator' });

export {
  AiJob,
  Category,
  ClassClaim,
  ClassStudent,
  FileRecord,
  Homework,
  Lesson,
  LinkAudit,
  Notification,
  RefreshToken,
  SchoolClass,
  Submission,
  SubmissionPage,
  Unit,
  User,
};
