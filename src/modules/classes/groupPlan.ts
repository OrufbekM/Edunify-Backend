import { GROUP_CAP, LESSON_CAP, UNIT_CAP } from '../../lib/caps.js';
import { AppError } from '../../lib/errors.js';

// What saving `linkedClassIds` does (contract 4.1 and 8.3), worked out from counts alone, so
// the preview and the save run the same function and can't disagree (plan, Phase 17).

export interface ClassFacts {
  id: string;
  name: string;
  groupId: string | null;
  // Placements in the class; in a group these include the group's units and linked lessons.
  units: number;
  lessons: number;
  linkedLessons: number;
}

export interface GroupFacts {
  id: string;
  memberIds: string[];
  units: number;
  // For each linked lesson of the group, the classes that hold it.
  linkedLessonHolders: string[][];
}

export interface GroupPreviewItem {
  classId: string;
  name: string;
  addedUnits: number;
  addedLessons: number;
  convertedUnits: number;
  convertedLessons: number;
}

export interface GroupPlan {
  // The group being changed; null when the class being saved has none.
  groupId: string | null;
  // In this order: leaving classes get copies, then the class left alone (if any) gets them
  // and the group goes, then the joining classes come in. When a new group is made, the
  // class being saved joins first: it counts as the group.
  leaves: string[];
  dissolve: string | null;
  joins: string[];
  // The group of the class being saved after the save; empty when it ends up in none.
  members: string[];
  preview: GroupPreviewItem[];
}

export interface PlanInput {
  self: ClassFacts;
  group: GroupFacts | null;
  // Every class named: the class being saved, its group's classes and the listed ones.
  classes: ReadonlyMap<string, ClassFacts>;
  // Already checked: distinct, never the class itself, all the teacher's own.
  linkedClassIds: string[];
}

function byName(a: ClassFacts, b: ClassFacts): number {
  return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id);
}

export function planGroupChange({ self, group, classes, linkedClassIds }: PlanInput): GroupPlan {
  const facts = (id: string): ClassFacts => {
    const found = classes.get(id);

    if (!found) {
      throw new Error(`No facts for class ${id}`);
    }
    return found;
  };

  if (linkedClassIds.some((id) => facts(id).groupId !== null && facts(id).groupId !== self.groupId)) {
    throw new AppError('CLASS_IN_OTHER_GROUP');
  }

  const current = group?.memberIds ?? [];
  let leaves: string[] = [];
  let dissolve: string | null = null;
  let joins: string[] = [];
  let members: string[] = [];

  if (group === null) {
    joins = linkedClassIds.length > 0 ? [self.id, ...linkedClassIds] : [];
    members = joins;
  } else if (linkedClassIds.length === 0) {
    const rest = current.filter((id) => id !== self.id);

    leaves = [self.id];
    dissolve = rest.length === 1 ? (rest[0] as string) : null;
  } else {
    const wanted = new Set([self.id, ...linkedClassIds]);

    leaves = current.filter((id) => !wanted.has(id));
    joins = linkedClassIds.filter((id) => !current.includes(id));
    members = [...current.filter((id) => wanted.has(id)), ...joins];
  }

  // Validation keeps linkedClassIds to 9, so this holds already; it stays as the rule.
  if (members.length > GROUP_CAP) {
    throw new AppError('LIMIT_REACHED', `A group has at most ${GROUP_CAP} classes`, { classIds: [...members].sort() });
  }

  const groupUnits = group?.units ?? 0;
  // A linked lesson that only leaving classes hold is deleted before anyone joins.
  const linkedLessons = (group?.linkedLessonHolders ?? []).filter((holders) =>
    holders.some((id) => !leaves.includes(id)),
  ).length;
  const finalUnits = groupUnits + joins.reduce((sum, id) => sum + facts(id).units, 0);
  const stays = members.filter((id) => !joins.includes(id));

  if (joins.length > 0) {
    const over = new Set<string>();

    if (finalUnits > UNIT_CAP) {
      members.forEach((id) => over.add(id));
    }
    joins.filter((id) => facts(id).lessons + linkedLessons > LESSON_CAP).forEach((id) => over.add(id));

    if (over.size > 0) {
      throw new AppError('LIMIT_REACHED', 'A class would go over a cap', { classIds: [...over].sort() });
    }
  }

  const items = new Map<string, GroupPreviewItem>();
  const item = (id: string, counts: Omit<GroupPreviewItem, 'classId' | 'name'>) =>
    items.set(id, { classId: id, name: facts(id).name, ...counts });

  for (const id of joins) {
    item(id, { addedUnits: finalUnits - facts(id).units, addedLessons: linkedLessons, convertedUnits: 0, convertedLessons: 0 });
  }
  if (joins.length > 0) {
    for (const id of stays) {
      item(id, { addedUnits: finalUnits - groupUnits, addedLessons: 0, convertedUnits: 0, convertedLessons: 0 });
    }
  }
  for (const id of [...leaves, ...(dissolve ? [dissolve] : [])]) {
    item(id, { addedUnits: 0, addedLessons: 0, convertedUnits: facts(id).units, convertedLessons: facts(id).linkedLessons });
  }

  // The class being saved first, then the listed classes in their order, then the rest.
  const listed = [self.id, ...linkedClassIds];
  const rest = [...items.keys()]
    .filter((id) => !listed.includes(id))
    .map(facts)
    .sort(byName)
    .map((found) => found.id);
  const preview = [...listed, ...rest].flatMap((id) => {
    const found = items.get(id);
    return found ? [found] : [];
  });

  return { groupId: group?.id ?? null, leaves, dissolve, joins, members, preview };
}
