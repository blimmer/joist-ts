import Knex, { QueryBuilder } from "knex";
import {
  ColumnMeta,
  Entity,
  EntityConstructor,
  entityLimit,
  EntityMetadata,
  FilterOf,
  getMetadata,
  isEntity,
  OrderOf,
} from "./EntityManager";
import { ForeignKeySerde } from "./serde";
import { fail } from "./utils";

export type OrderBy = "ASC" | "DESC";

export type BooleanFilter<N> = true | false | N;

export type ValueFilter<V, N> =
  | V
  | V[]
  | N
  // Both eq and in are redundant with `V` and `V[]` above but are convenient for matching GQL filter APIs
  | { eq: V | N }
  | { in: V[] }
  | { gt: V }
  | { gte: V }
  | { ne: V | N }
  | { lt: V }
  | { lte: V }
  | { like: V }
  | { ilike: V };

// For filtering by a foreign key T, i.e. either joining/recursing into with FilterQuery<T>, or matching it is null/not null/etc.
export type EntityFilter<T, I, F, N> = T | I | I[] | F | N | { ne: T | I | N };

export type BooleanGraphQLFilter = true | false | null;

export type Primitive = string | boolean | Date | number;

/** This essentially matches the ValueFilter but with looser types to placate GraphQL. */
export type ValueGraphQLFilter<V> =
  | {
      eq?: V | null;
      in?: V[] | null;
      gt?: V | null;
      gte?: V | null;
      ne?: V | null;
      lt?: V | null;
      lte?: V | null;
      like?: V | null;
      ilike?: V | null;
    }
  | { op: Operator; value: Primitive }
  | V
  | V[]
  | null;

export type EnumGraphQLFilter<V> = V[] | null | undefined;

/** A GraphQL version of EntityFilter. */
export type EntityGraphQLFilter<T, I, F> = T | I | I[] | F | { ne: T | I } | null | undefined;

const operators = ["eq", "gt", "gte", "ne", "lt", "lte", "like", "ilike", "in"] as const;
export type Operator = typeof operators[number];
const opToFn: Record<Operator, string> = {
  eq: "=",
  gt: ">",
  gte: ">=",
  ne: "!=",
  lt: "<",
  lte: "<=",
  like: "LIKE",
  ilike: "ILIKE",
  in: "...",
};

export type FilterAndSettings<T> = {
  where: FilterOf<T>;
  orderBy?: OrderOf<T>;
  limit?: number;
  offset?: number;
};

/**
 * Builds the SQL/knex queries for `EntityManager.find` calls.
 *
 * Note this is generally for our own internal implementation details and not meant to
 * be a user-facing QueryBuilder, i.e. users should use Knex for that and just use SQL
 * directly (for any non-trivial queries that `EntityManager.find` does not support).
 */
export function buildQuery<T extends Entity>(
  knex: Knex,
  type: EntityConstructor<T>,
  filter: FilterAndSettings<T>,
): QueryBuilder<{}, unknown[]> {
  const meta = getMetadata(type);
  const { where, orderBy, limit, offset } = filter;

  const aliases: Record<string, number> = {};
  function getAlias(tableName: string): string {
    const abbrev = abbreviation(tableName);
    const i = aliases[abbrev] || 0;
    aliases[abbrev] = i + 1;
    return `${abbrev}${i}`;
  }

  const alias = getAlias(meta.tableName);
  let query: QueryBuilder<any, any> = knex.select<unknown>(`${alias}.*`).from(`${meta.tableName} AS ${alias}`);

  // Define a function for recursively adding joins & filters
  function addClauses(
    meta: EntityMetadata<any>,
    alias: string,
    where: object | undefined,
    orderBy: object | undefined,
  ): void {
    // Combine the where and orderBy keys so that we can add them to aliases as that same time
    const keys = [...(where ? Object.keys(where) : []), ...(orderBy ? Object.keys(orderBy) : [])];

    keys.forEach((key) => {
      const column = meta.columns.find((c) => c.fieldName === key) || fail(`${key} not found`);

      // We may/may not have a where clause or orderBy for this key, but we should have at least one of them.
      const clause = where && (where as any)[key];
      const hasClause = where && key in where;
      const order = orderBy && (orderBy as any)[key];
      const hasOrder = !!order;

      if (column.serde instanceof ForeignKeySerde) {
        // Add `otherTable.column = ...` clause, unless `key` is not in `where`, i.e. there is only an orderBy for this fk
        let [whereNeedsJoin, _query] = hasClause ? addForeignKeyClause(query, alias, column, clause) : [false, query];
        query = _query;
        if (whereNeedsJoin || hasOrder) {
          // Add a join for this column
          const otherMeta = column.serde.otherMeta();
          const otherAlias = getAlias(otherMeta.tableName);
          query = query.innerJoin(
            `${otherMeta.tableName} AS ${otherAlias}`,
            `${alias}.${column.columnName}`,
            `${otherAlias}.id`,
          );
          // Then recurse to add its conditions to the query
          addClauses(otherMeta, otherAlias, whereNeedsJoin ? clause : undefined, hasOrder ? order : undefined);
        }
      } else {
        query = hasClause ? addPrimitiveClause(query, alias, column, clause) : query;
        // This is not a foreign key column, so it'll have the primitive filters/order bys
        if (order) {
          query = query.orderBy(`${alias}.${column.columnName}`, order);
        }
      }
    });
  }

  addClauses(meta, alias, where as object, orderBy as object);

  // Even if they already added orders, add id as the last one to get deterministic output
  query = query.orderBy(`${alias}.id`);
  query = query.limit(limit || entityLimit);
  if (offset) {
    query = query.offset(offset);
  }

  return query as QueryBuilder<{}, unknown[]>;
}

function abbreviation(tableName: string): string {
  return tableName
    .split("_")
    .map((w) => w[0])
    .join("");
}

function addForeignKeyClause(
  query: QueryBuilder,
  alias: string,
  column: ColumnMeta,
  clause: any,
): [boolean, QueryBuilder] {
  // I.e. this could be { authorFk: authorEntity | null | id | { ...recurse... } }
  const clauseKeys = typeof clause === "object" && clause !== null ? Object.keys(clause as object) : [];
  if (isEntity(clause) || typeof clause == "string" || Array.isArray(clause)) {
    // I.e. { authorFk: authorEntity | id | id[] }
    if (isEntity(clause) && clause.id === undefined) {
      // The user is filtering on an unsaved entity, which will just never have any rows, so throw in -1
      return [false, query.where(`${alias}.${column.columnName}`, -1)];
    } else if (Array.isArray(clause)) {
      return [
        false,
        query.whereIn(
          `${alias}.${column.columnName}`,
          clause.map((id) => column.serde.mapToDb(id)),
        ),
      ];
    } else {
      return [false, query.where(`${alias}.${column.columnName}`, column.serde.mapToDb(clause))];
    }
  } else if (clause === null || clause === undefined) {
    // I.e. { authorFk: null | undefined }
    return [false, query.whereNull(`${alias}.${column.columnName}`)];
  } else if (clauseKeys.length === 1 && clauseKeys[0] === "id") {
    // I.e. { authorFk: { id: string } } || { authorFk: { id: string[] } }
    // If only querying on the id, we can skip the join
    const value = (clause as any)["id"];
    if (Array.isArray(value)) {
      return [
        false,
        query.whereIn(
          `${alias}.${column.columnName}`,
          value.map((id) => column.serde.mapToDb(id)),
        ),
      ];
    } else {
      return [false, query.where(`${alias}.${column.columnName}`, column.serde.mapToDb(value))];
    }
  } else if (clauseKeys.length === 1 && clauseKeys[0] === "ne") {
    // I.e. { authorFk: { ne: string | null | undefined } }
    const value = (clause as any)["ne"];
    if (value === null || value === undefined) {
      return [false, query.whereNotNull(`${alias}.${column.columnName}`)];
    } else if (typeof value === "string") {
      return [false, query.whereNot(`${alias}.${column.columnName}`, column.serde.mapToDb(value))];
    } else {
      throw new Error("Not implemented");
    }
  } else {
    // I.e. { authorFk: { ...authorFilter... } }
    return [clause !== undefined, query];
  }
}

function addPrimitiveClause(query: QueryBuilder, alias: string, column: ColumnMeta, clause: any): QueryBuilder {
  if (clause && typeof clause === "object" && operators.find((op) => Object.keys(clause).includes(op))) {
    // I.e. `{ primitiveField: { gt: value } }`
    const op = Object.keys(clause)[0] as Operator;
    return addPrimitiveOperator(query, alias, column, op, (clause as any)[op]);
  } else if (clause && typeof clause === "object" && "op" in clause) {
    // I.e. { primitiveField: { op: "gt", value: 1 } }`
    return addPrimitiveOperator(query, alias, column, clause.op, clause.value);
  } else if (Array.isArray(clause)) {
    // I.e. `{ primitiveField: value[] }`
    return query.whereIn(
      `${alias}.${column.columnName}`,
      clause.map((v) => column.serde.mapToDb(v)),
    );
  } else if (clause === null) {
    // I.e. `{ primitiveField: null }`
    return query.whereNull(`${alias}.${column.columnName}`);
  } else if (clause === undefined) {
    // I.e. `{ primitiveField: undefined }`
    // Currently we treat this like a partial filter, i.e. don't include it. Seems odd
    // unless this is opt-in, i.e. maybe only do this for `findGql`?
    return query;
  } else if (clause !== undefined) {
    // I.e. `{ primitiveField: value }`
    // TODO In theory could add a addToQuery method to Serde to generalize this to multi-columns fields.
    return query.where(`${alias}.${column.columnName}`, column.serde.mapToDb(clause));
  } else {
    return fail(`Unhandled primitive clause ${clause}`);
  }
}

function addPrimitiveOperator(
  query: QueryBuilder,
  alias: string,
  column: ColumnMeta,
  op: Operator,
  value: any,
): QueryBuilder {
  if (value === null || value === undefined) {
    if (op === "ne") {
      return query.whereNotNull(`${alias}.${column.columnName}`);
    } else if (op === "eq") {
      return query.whereNull(`${alias}.${column.columnName}`);
    } else {
      throw new Error("Only ne is supported when the value is undefined or null");
    }
  } else if (op === "in") {
    return query.whereIn(
      `${alias}.${column.columnName}`,
      (value as Array<any>).map((v) => column.serde.mapToDb(v)),
    );
  } else {
    const fn = opToFn[op] || fail(`Invalid operator ${op}`);
    return query.where(`${alias}.${column.columnName}`, fn, column.serde.mapToDb(value));
  }
}
