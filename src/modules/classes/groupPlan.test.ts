import { describe, expect, it } from 'vitest';

import { AppError } from '../../lib/errors.js';
import { planGroupChange, type ClassFacts, type GroupFacts, type PlanInput } from './groupPlan.js';

// The pure part of a group change (contract 4.1 and 8.3): who leaves, who joins, what each
// class gets, and the caps. The database side runs this same function for the preview and
// the save.

function facts(id: string, overrides: Partial<ClassFacts> = {}): ClassFacts {
  return { id, name: id.toUpperCase(), groupId: null, units: 1, lessons: 0, linkedLessons: 0, ...overrides };
}

function plan(self: ClassFacts, others: ClassFacts[], linkedClassIds: string[], group: GroupFacts | null = null) {
  const input: PlanInput = {
    self,
    group,
    classes: new Map([self, ...others].map((found) => [found.id, found])),
    linkedClassIds,
  };
  return planGroupChange(input);
}

function errorOf(work: () => unknown): AppError {
  try {
    work();
  } catch (err) {
    if (err instanceof AppError) {
      return err;
    }
    throw err;
  }
  throw new Error('Expected an AppError');
}

const group = (memberIds: string[], units: number, linkedLessonHolders: string[][] = []): GroupFacts => ({
  id: 'g',
  memberIds,
  units,
  linkedLessonHolders,
});

describe('planGroupChange', () => {
  it('does nothing for a class outside a group and an empty list', () => {
    expect(plan(facts('a'), [], [])).toEqual({ groupId: null, leaves: [], dissolve: null, joins: [], members: [], preview: [] });
  });

  it('makes a new group: the saving class joins first and counts as the group', () => {
    const result = plan(facts('a', { units: 2 }), [facts('b', { units: 1 }), facts('c', { units: 3 })], ['b', 'c']);

    expect(result).toMatchObject({ groupId: null, leaves: [], dissolve: null, joins: ['a', 'b', 'c'], members: ['a', 'b', 'c'] });
    expect(result.preview).toEqual([
      { classId: 'a', name: 'A', addedUnits: 4, addedLessons: 0, convertedUnits: 0, convertedLessons: 0 },
      { classId: 'b', name: 'B', addedUnits: 5, addedLessons: 0, convertedUnits: 0, convertedLessons: 0 },
      { classId: 'c', name: 'C', addedUnits: 3, addedLessons: 0, convertedUnits: 0, convertedLessons: 0 },
    ]);
  });

  it('changes nothing when the list is the group as it is', () => {
    const inGroup = { groupId: 'g', units: 2 };
    const result = plan(facts('a', inGroup), [facts('b', inGroup)], ['b'], group(['a', 'b'], 2));

    expect(result).toMatchObject({ leaves: [], joins: [], dissolve: null, members: ['a', 'b'], preview: [] });
  });

  it('dissolves a group of two when the saving class leaves: both get copies', () => {
    const result = plan(
      facts('a', { groupId: 'g', units: 3, linkedLessons: 2 }),
      [facts('b', { groupId: 'g', units: 3, linkedLessons: 1 })],
      [],
      group(['a', 'b'], 3, [['a', 'b'], ['a']]),
    );

    expect(result).toMatchObject({ groupId: 'g', leaves: ['a'], dissolve: 'b', joins: [], members: [] });
    expect(result.preview).toEqual([
      { classId: 'a', name: 'A', addedUnits: 0, addedLessons: 0, convertedUnits: 3, convertedLessons: 2 },
      { classId: 'b', name: 'B', addedUnits: 0, addedLessons: 0, convertedUnits: 3, convertedLessons: 1 },
    ]);
  });

  it('lets one class leave a bigger group without dissolving it', () => {
    const inGroup = { groupId: 'g', units: 2 };
    const result = plan(facts('a', inGroup), [facts('b', inGroup), facts('c', inGroup)], [], group(['a', 'b', 'c'], 2));

    expect(result).toMatchObject({ leaves: ['a'], dissolve: null, joins: [], members: [] });
    expect(result.preview.map((item) => item.classId)).toEqual(['a']);
  });

  it('lets classes leave and join in one save: leaving first, linked lessons only they held not passed on', () => {
    const inGroup = { groupId: 'g', units: 2 };
    const result = plan(
      facts('a', { ...inGroup, linkedLessons: 1 }),
      [
        facts('b', { ...inGroup, linkedLessons: 1 }),
        facts('c', { ...inGroup, name: 'Zeta', linkedLessons: 2 }),
        facts('d', { units: 1, lessons: 4 }),
      ],
      ['d', 'b'],
      group(['a', 'b', 'c'], 2, [['a', 'b', 'c'], ['c']]),
    );

    expect(result).toMatchObject({ leaves: ['c'], joins: ['d'], dissolve: null, members: ['a', 'b', 'd'] });
    expect(result.preview).toEqual([
      { classId: 'a', name: 'A', addedUnits: 1, addedLessons: 0, convertedUnits: 0, convertedLessons: 0 },
      { classId: 'd', name: 'D', addedUnits: 2, addedLessons: 1, convertedUnits: 0, convertedLessons: 0 },
      { classId: 'b', name: 'B', addedUnits: 1, addedLessons: 0, convertedUnits: 0, convertedLessons: 0 },
      { classId: 'c', name: 'Zeta', addedUnits: 0, addedLessons: 0, convertedUnits: 2, convertedLessons: 2 },
    ]);
  });

  it('lists the other changed classes by name after the listed ones', () => {
    const inGroup = { groupId: 'g' };
    const result = plan(
      facts('a', inGroup),
      [facts('b', { ...inGroup, name: 'beta' }), facts('c', { ...inGroup, name: 'Alpha' }), facts('d')],
      ['d'],
      group(['a', 'b', 'c'], 1),
    );

    expect(result.preview.map((item) => item.name)).toEqual(['A', 'D', 'Alpha', 'beta']);
  });

  it('gives CLASS_IN_OTHER_GROUP for a listed class in another group, from outside a group or inside one', () => {
    const elsewhere = facts('b', { groupId: 'other' });

    expect(errorOf(() => plan(facts('a'), [elsewhere], ['b'])).code).toBe('CLASS_IN_OTHER_GROUP');
    expect(
      errorOf(() => plan(facts('a', { groupId: 'g' }), [facts('c', { groupId: 'g' }), elsewhere], ['c', 'b'], group(['a', 'c'], 1)))
        .code,
    ).toBe('CLASS_IN_OTHER_GROUP');
  });

  it('takes a group of exactly 100 units and gives LIMIT_REACHED with every class for 101', () => {
    expect(plan(facts('a', { units: 60 }), [facts('b', { units: 40 })], ['b']).joins).toEqual(['a', 'b']);

    const err = errorOf(() => plan(facts('b', { units: 60 }), [facts('a', { units: 41 })], ['a']));
    expect(err.code).toBe('LIMIT_REACHED');
    expect(err.details).toEqual({ classIds: ['a', 'b'] });
  });

  it('gives LIMIT_REACHED naming only a joining class that would hold over 500 lessons', () => {
    const inGroup = { groupId: 'g', lessons: 499 };
    const input = (lessons: number) =>
      plan(facts('a', inGroup), [facts('b', inGroup), facts('c', { lessons })], ['b', 'c'], group(['a', 'b'], 1, [['a', 'b'], ['a']]));

    expect(input(498).joins).toEqual(['c']);

    const err = errorOf(() => input(499));
    expect(err.code).toBe('LIMIT_REACHED');
    expect(err.details).toEqual({ classIds: ['c'] });
  });

  it('keeps a group to 10 classes', () => {
    const others = Array.from({ length: 10 }, (_, index) => facts(`c${index}`));
    const err = errorOf(() => plan(facts('a'), others, others.map((found) => found.id)));

    expect(err.code).toBe('LIMIT_REACHED');
    expect(plan(facts('a'), others.slice(0, 9), others.slice(0, 9).map((found) => found.id)).members).toHaveLength(10);
  });
});
