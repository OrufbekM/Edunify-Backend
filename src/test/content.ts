import { api, type TestUser } from './users.js';

// The id of a class's first unit. Every class starts with one (contract 8.3), and every lesson
// needs one (contract 8.6).
export async function firstUnitId(user: TestUser, classId: string): Promise<string> {
  const res = await api(user).get(`/api/v1/classes/${classId}/outline`);
  const unit = res.body.units?.[0] as { id: string } | undefined;

  if (!unit) {
    throw new Error(`class ${classId} has no unit (status ${res.status})`);
  }
  return unit.id;
}
