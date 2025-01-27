//@ts-nocheck

const fs = require("fs");
const path = require("path");

const { getDMMF } = require("@prisma/internals");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

async function loadDMMF(seedPath) {
  const schemaPath = path.join(seedPath);
  const schema = fs.readFileSync(schemaPath, "utf-8");
  return getDMMF({ datamodel: schema });
}

function generateFakeValueForField(field) {
  const { type, isId, isUnique, isList, isRequired } = field;

  if (isList) return [];

  switch (type) {
    case "String":
      if (isId) return undefined;

      if (isUnique) return `unique_${Math.random().toString(36).slice(2, 10)}`;
      return `fake_${field.name}`;

    case "Int":
      return 123;

    case "Float":
      return 1.23;

    case "Boolean":
      return false;

    case "DateTime":
      return new Date();

    case "Json":
      return { example: "data" };

    default:
      return isRequired ? `fake_${field.name}` : null;
  }
}

function buildDependencyGraph(models) {
  const graph = {};

  for (const model of models) {
    graph[model.name] = {
      name: model.name,
      dependsOn: new Set(),
      referencedBy: new Set(),
    };
  }

  for (const model of models) {
    for (const field of model.fields) {
      if (field.kind === "object" && !field.isList && field.isRequired) {
        const dependsOnModel = field.type;
        if (graph[dependsOnModel]) {
          graph[model.name].dependsOn.add(dependsOnModel);
          graph[dependsOnModel].referencedBy.add(model.name);
        }
      }
    }
  }

  return graph;
}

function topologicalSort(graph) {
  const inDegree = {};
  for (const modelName of Object.keys(graph)) {
    inDegree[modelName] = graph[modelName].dependsOn.size;
  }

  const queue = Object.keys(inDegree).filter((m) => inDegree[m] === 0);
  const sorted = [];

  while (queue.length) {
    const current = queue.shift();
    sorted.push(current);

    for (const ref of graph[current].referencedBy) {
      inDegree[ref]--;
      if (inDegree[ref] === 0) {
        queue.push(ref);
      }
    }
  }

  if (sorted.length < Object.keys(graph).length) {
    console.warn(
      "⚠️ Possível ciclo de dependências. A ordenação pode estar incompleta."
    );

    const remaining = Object.keys(inDegree).filter((m) => inDegree[m] > 0);
    return [...sorted, ...remaining];
  }

  return sorted;
}

async function tryCreateOneRecord(modelDataMap, modelName) {
  const { model, createdRecords } = modelDataMap[modelName];
  const data = {};

  for (const field of model.fields) {
    if (field.kind === "scalar" && !field.isReadOnly) {
      data[field.name] = generateFakeValueForField(field);
    }
  }

  for (const field of model.fields) {
    if (field.kind !== "object") continue;

    const { relationFromFields, relationToFields, type, isList } = field;
    if (isList) continue;

    if (!relationFromFields || relationFromFields.length === 0) continue;

    let anyFKrequired = false;
    relationFromFields.forEach((fkFieldName) => {
      const fkDef = model.fields.find((f) => f.name === fkFieldName);
      if (fkDef?.isRequired) {
        anyFKrequired = true;
      }
    });

    const relatedModelData = modelDataMap[type];
    if (!relatedModelData) {
      if (anyFKrequired) {
        data[field.name] = undefined;
      }
      continue;
    }

    const firstRecord = relatedModelData.createdRecords[0];
    if (firstRecord) {
      data[field.name] = { connect: {} };
      if (relationToFields?.length === 1) {
        const foreignKey = relationToFields[0];
        data[field.name].connect[foreignKey] = firstRecord[foreignKey];
      } else {
        relationToFields.forEach((rk) => {
          data[field.name].connect[rk] = firstRecord[rk];
        });
      }
    } else {
      if (anyFKrequired) {
        // console.warn(
        //     `⚠️  O campo '${field.name}' em '${modelName}' é obrigatório, mas não há registro em '${type}' ainda.`
        // );
        data[field.name] = undefined;
      } else {
        data[field.name] = undefined;
      }
    }
  }

  try {
    const created = await prisma[modelName].create({ data });
    createdRecords.push(created);
    console.log(
      `  ✅ Registro criado em ${modelName} (ID: ${
        created.id || Object.values(created)[0]
      })`
    );
    return true;
  } catch (err) {
    console.warn(
      `  🛠️ Falha ao criar ${modelName}. Aguardar proxima passada...`
    );
    return false;
  }
}

async function multiPassCreate(dmmf, maxPasses = 5) {
  const models = dmmf.datamodel.models;

  const graph = buildDependencyGraph(models);
  let sortedModelNames = topologicalSort(graph);

  const modelDataMap = {};
  for (const m of models) {
    modelDataMap[m.name] = {
      model: m,
      createdRecords: [],
      created: false,
    };
  }

  let pass = 1;
  while (pass <= maxPasses) {
    console.log(`\n=== Iniciando pass #${pass} ===`);
    let createdSomethingThisPass = false;

    for (const modelName of sortedModelNames) {
      if (modelDataMap[modelName].created) continue;

      const success = await tryCreateOneRecord(modelDataMap, modelName);
      if (success) {
        modelDataMap[modelName].created = true;
        createdSomethingThisPass = true;
      }
    }

    if (!createdSomethingThisPass) {
      console.log("⚠️ Sem mais registros para criar...");
      break;
    }
    pass++;
  }

  return modelDataMap;
}

export const generateSeedData = async (seedPath) => {
  try {
    console.log("Lendo schema.prisma...");
    const dmmfData = await loadDMMF(seedPath);

    console.log("Iniciando criação de registros...");
    await multiPassCreate(dmmfData, 5);

    console.log("\n✅ Seed finalizado com sucesso!");
  } catch (error) {
    console.error("❌ Erro durante a geração de seed:", error);
    throw error;
  } finally {
    await prisma.$disconnect();
  }
};
