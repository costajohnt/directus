import { GraphQLNonNull } from 'graphql';
// eslint-disable-next-line import/order
import { beforeEach, describe, expect, test, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted() ensures the mock fn exists when the vi.mock factory
// runs (factories are hoisted to the top of the file by Vitest).
// ---------------------------------------------------------------------------

const { mockApplyFunctionToColumnName } = vi.hoisted(() => ({
	mockApplyFunctionToColumnName: vi.fn((col: string) => col),
}));

vi.mock('../../../database/run-ast/utils/apply-function-to-column-name.js', () => ({
	applyFunctionToColumnName: mockApplyFunctionToColumnName,
}));

// graphql-compose's compiled CJS code triggers instanceof checks against a
// different graphql instance than the ESM one, crashing TypeMapper. Stub the
// module so get-types.ts can load without that conflict.
vi.mock('graphql-compose', () => ({
	GraphQLJSON: { name: 'JSON' },
	ObjectTypeComposer: class {},
}));

// Static import — works with vi.mock hoisting (mocks are applied first).
import { getTypes } from './get-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Lightweight TC that records every field set on it. */
function makeTC(name: string, initialFields: Record<string, any> = {}) {
	const fields: Record<string, any> = { ...initialFields };

	return {
		name,
		getFields: () => fields,
		addFields: (f: Record<string, any>) => Object.assign(fields, f),
		clone: (n: string) => makeTC(n, { ...fields }),
	};
}

/**
 * Minimal SchemaComposer stand-in — captures ObjectTC definitions and returns
 * inspectable TC objects without invoking graphql-compose's TypeMapper.
 */
function makeSchemaComposer() {
	const tcs = new Map<string, ReturnType<typeof makeTC>>();

	return {
		tcs,
		createObjectTC({ name, fields = {} }: { name: string; fields?: Record<string, any> }) {
			const tc = makeTC(name, fields);
			tcs.set(name, tc);
			return tc;
		},
	};
}

function makeSchema(action: 'read' | 'create' | 'update', collections: Record<string, any>) {
	const empty = { collections: {}, relations: [] };

	return {
		read: action === 'read' ? { collections, relations: [] } : empty,
		create: action === 'create' ? { collections, relations: [] } : empty,
		update: action === 'update' ? { collections, relations: [] } : empty,
		delete: empty,
	};
}

function makeCollection(name: string, fields: Record<string, any>) {
	return { collection: name, primary: 'id', singleton: false, fields };
}

function makeField(name: string, type: string) {
	return { field: name, type, special: [], note: null, nullable: true, defaultValue: null };
}

const mockInconsistentFields = { read: {}, create: {}, update: {}, delete: {} } as any;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getTypes – json() inside {field}_func (Phase 3)', () => {
	let sc: ReturnType<typeof makeSchemaComposer>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockApplyFunctionToColumnName.mockImplementation((col: string) => col);
		sc = makeSchemaComposer();
	});

	test('json field gets a {field}_func entry in the read CollectionType', () => {
		const schema = makeSchema('read', {
			articles: makeCollection('articles', {
				id: makeField('id', 'integer'),
				metadata: makeField('metadata', 'json'),
			}),
		});

		const { CollectionTypes } = getTypes(sc as any, 'items', schema as any, mockInconsistentFields, 'read');

		expect(CollectionTypes['articles']!.getFields()).toHaveProperty('metadata_func');
	});

	test('{field}_func for a json field has a json sub-field with a path arg', () => {
		const schema = makeSchema('read', {
			articles: makeCollection('articles', {
				metadata: makeField('metadata', 'json'),
			}),
		});

		getTypes(sc as any, 'items', schema as any, mockInconsistentFields, 'read');

		const funcType = sc.tcs.get('articles_metadata_func');
		expect(funcType).toBeDefined();
		expect(funcType!.getFields()).toHaveProperty('json');
		expect(funcType!.getFields()['json'].args).toHaveProperty('path');
	});

	test('{field}_func json resolver calls applyFunctionToColumnName and returns the right value', () => {
		mockApplyFunctionToColumnName.mockReturnValue('metadata_color_json');

		const schema = makeSchema('read', {
			articles: makeCollection('articles', {
				metadata: makeField('metadata', 'json'),
			}),
		});

		getTypes(sc as any, 'items', schema as any, mockInconsistentFields, 'read');

		const funcType = sc.tcs.get('articles_metadata_func');
		const jsonSubField = funcType!.getFields()['json'] as any;
		const obj = { metadata_color_json: '#ff0000' };

		const result = jsonSubField!.resolve(obj, { path: 'color' }, undefined, undefined);

		expect(mockApplyFunctionToColumnName).toHaveBeenCalledWith('json(metadata, color)');
		expect(result).toBe('#ff0000');
	});

	test('{field}_func for a json field also has a count sub-field', () => {
		const schema = makeSchema('read', {
			articles: makeCollection('articles', {
				metadata: makeField('metadata', 'json'),
			}),
		});

		getTypes(sc as any, 'items', schema as any, mockInconsistentFields, 'read');

		const funcType = sc.tcs.get('articles_metadata_func');
		expect(funcType!.getFields()).toHaveProperty('count');
	});

	test('{field}_func count resolver reads the {field}_count key from obj', () => {
		const schema = makeSchema('read', {
			articles: makeCollection('articles', {
				metadata: makeField('metadata', 'json'),
			}),
		});

		getTypes(sc as any, 'items', schema as any, mockInconsistentFields, 'read');

		const funcType = sc.tcs.get('articles_metadata_func');
		const countSubField = funcType!.getFields()['count'] as any;
		const obj = { metadata_count: 42 };

		expect(countSubField.resolve(obj)).toBe(42);
	});

	test('{field}_func resolver passes obj through for json fields', () => {
		const schema = makeSchema('read', {
			articles: makeCollection('articles', {
				metadata: makeField('metadata', 'json'),
			}),
		});

		const { CollectionTypes } = getTypes(sc as any, 'items', schema as any, mockInconsistentFields, 'read');

		const funcField = CollectionTypes['articles']!.getFields()['metadata_func'] as any;
		const obj = { metadata_count: 3, some_other: 'x' };

		expect(funcField.resolve(obj)).toBe(obj);
	});

	test('alias field does NOT get a per-field json func type', () => {
		const schema = makeSchema('read', {
			articles: makeCollection('articles', {
				tags: makeField('tags', 'alias'),
			}),
		});

		getTypes(sc as any, 'items', schema as any, mockInconsistentFields, 'read');

		expect(sc.tcs.has('articles_tags_func')).toBe(false);
	});

	test('create action does NOT add {field}_func for json fields', () => {
		const schema = makeSchema('create', {
			articles: makeCollection('articles', {
				metadata: makeField('metadata', 'json'),
			}),
		});

		const { CollectionTypes } = getTypes(sc as any, 'items', schema as any, mockInconsistentFields, 'create');

		expect(CollectionTypes['articles']!.getFields()).not.toHaveProperty('metadata_func');
	});
});

describe('getTypes – non-null fields with a default value', () => {
	let sc: ReturnType<typeof makeSchemaComposer>;

	beforeEach(() => {
		sc = makeSchemaComposer();
	});

	function getTypesFor(
		action: 'read' | 'create' | 'update',
		size: Record<string, any>,
		{
			inconsistent = [],
			collection = 'blocks',
			id = {},
		}: { inconsistent?: string[]; collection?: string; id?: Record<string, any> } = {},
	) {
		const schema = makeSchema(action, {
			[collection]: makeCollection(collection, {
				id: { ...makeField('id', 'integer'), nullable: false, ...id },
				size: { ...makeField('size', 'string'), ...size },
			}),
		});

		// Without an entry for the collection, fieldIsInconsistent is undefined and no field is ever non-null
		const inconsistentFields = { ...mockInconsistentFields, [action]: { [collection]: inconsistent } };

		const { CollectionTypes } = getTypes(sc as any, 'items', schema as any, inconsistentFields, action);

		return CollectionTypes[collection]!.getFields();
	}

	function getSizeType(action: 'read' | 'create' | 'update', size: Record<string, any>) {
		return getTypesFor(action, size)['size']!.type;
	}

	test('read marks a non-null field with a default as non-null', () => {
		expect(getSizeType('read', { nullable: false, defaultValue: 'small' })).toBeInstanceOf(GraphQLNonNull);
	});

	test('create keeps a non-null field with a default optional', () => {
		expect(getSizeType('create', { nullable: false, defaultValue: 'small' })).not.toBeInstanceOf(GraphQLNonNull);
	});

	test('read and create mark a non-null field without a default as non-null', () => {
		expect(getSizeType('read', { nullable: false })).toBeInstanceOf(GraphQLNonNull);
		expect(getSizeType('create', { nullable: false })).toBeInstanceOf(GraphQLNonNull);
	});

	test('update keeps non-null fields optional', () => {
		expect(getSizeType('update', { nullable: false, defaultValue: 'small' })).not.toBeInstanceOf(GraphQLNonNull);
		expect(getSizeType('update', { nullable: false })).not.toBeInstanceOf(GraphQLNonNull);
	});

	test('read keeps a nullable field with a default nullable', () => {
		expect(getSizeType('read', { nullable: true, defaultValue: 'small' })).not.toBeInstanceOf(GraphQLNonNull);
	});

	test('read keeps a non-null field with a default nullable when permissions can hide it', () => {
		const fields = getTypesFor('read', { nullable: false, defaultValue: 'small' }, { inconsistent: ['size'] });

		expect(fields['size']!.type).not.toBeInstanceOf(GraphQLNonNull);
	});

	test('generated fields stay optional on create and nullable on read', () => {
		const size = { nullable: false, special: ['date-created'] };

		expect(getSizeType('create', size)).not.toBeInstanceOf(GraphQLNonNull);
		expect(getSizeType('read', size)).not.toBeInstanceOf(GraphQLNonNull);
	});

	test('primary key is non-null on read, and optional on create when generated', () => {
		expect(getTypesFor('read', {})['id']!.type).toBeInstanceOf(GraphQLNonNull);
		expect(getTypesFor('create', {})['id']!.type).toBeInstanceOf(GraphQLNonNull);
		expect(getTypesFor('create', {}, { id: { special: ['uuid'] } })['id']!.type).not.toBeInstanceOf(GraphQLNonNull);
		expect(getTypesFor('update', {})['id']!.type).not.toBeInstanceOf(GraphQLNonNull);
		expect(getTypesFor('read', {}, { inconsistent: ['id'] })['id']!.type).not.toBeInstanceOf(GraphQLNonNull);
	});

	test('directus_permissions primary key stays nullable', () => {
		expect(getTypesFor('read', {}, { collection: 'directus_permissions' })['id']!.type).not.toBeInstanceOf(
			GraphQLNonNull,
		);
	});
});
