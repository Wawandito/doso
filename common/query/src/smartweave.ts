import Arweave from "arweave";
import { Query } from "./index";
import { getData } from "@kyve/core";
import { arweaveClient } from "@kyve/core/dist/extensions";
import ArDB from "ardb";
import {ContractInteraction, execute} from "smartweave/lib/contract-step";
import {InteractionTx} from "smartweave/lib/interaction-tx";
import {arrayToHex, formatTags} from "smartweave/lib/utils";
import {GQLEdgeTransactionInterface} from "ardb/lib/faces/gql";
import {loadContract} from "smartweave";

export const readContract = async (
  poolID: number,
  contractID: string,
  returnValidity: boolean,
  arweave: Arweave = arweaveClient
) => {
  // load last KYVE state for this contract
  const query = new Query(poolID, false, arweave);

  const result = await query
    .tag("Contract", contractID)
    .only(["id", "tags", "tags.name", "tags.value"])
    .limit(1)
    .find();
  if (!result) {
    throw new Error("No mtaching transactions in pool found.");
  }

  const transaction = result[0];

  // find 'Block' tag
  const latestArchivedBlock = parseInt(
    transaction.tags.find(
      (tag: { name: string; value: string }) => tag.name == "Block"
    ).value
  );

  const data: { state: object } = JSON.parse(await getData(transaction.id));
  let state = data.state

  // find txs from
  const ardb = new ArDB(arweave)
  const missingTXs = await ardb
    .sort("HEIGHT_ASC")
    .min(latestArchivedBlock + 1)
    .tags([
      { name: "App-Name", values: ["SmartWeaveAction"] },
      { name: "Contract", values: [contractID] },
    ])
    .findAll() as GQLEdgeTransactionInterface[];

  // from https://github.com/ArweaveTeam/SmartWeave/blob/master/src/contract-read.ts#L56
  console.log(`Replaying ${missingTXs.length} confirmed interactions`);

  await sortTransactions(arweave, missingTXs);

  const contractInfo = await loadContract(arweave, contractID)
  const { handler, swGlobal } = contractInfo;

  const validity: Record<string, boolean> = {};

  for (const txInfo of missingTXs) {
    const tags = formatTags(txInfo.node.tags);

    const currentTx: InteractionTx = {
      ...txInfo.node,
      tags,
    };

    let input = currentTx.tags.Input;

    // Check that input is not an array. If a tx has multiple input tags, it will be an array
    if (Array.isArray(input)) {
      console.warn(`Skipping tx with multiple Input tags - ${currentTx.id}`);
      continue;
    }

    try {
      input = JSON.parse(input);
    } catch (e) {
      console.log(e);
      continue;
    }

    if (!input) {
      console.log(`Skipping tx with missing or invalid Input tag - ${currentTx.id}`);
      continue;
    }

    const interaction: ContractInteraction = {
      input,
      caller: currentTx.owner.address,
    };

    swGlobal._activeTx = currentTx;

    const result = await execute(handler, interaction, state);

    if (result.type === 'exception') {
      console.warn(`Executing of interaction: ${currentTx.id} threw exception.`);
      console.warn(`${result.result}`);
    }
    if (result.type === 'error') {
      console.warn(`Executing of interaction: ${currentTx.id} returned error.`);
      console.warn(`${result.result}`);
    }

    validity[currentTx.id] = result.type === 'ok';

    state = result.state;
  }

  return returnValidity ? { state, validity } : state;
};


// Sort the transactions based on the sort key generated in addSortKey()
async function sortTransactions(arweave: Arweave, txInfos: any[]) {
  const addKeysFuncs = txInfos.map((tx) => addSortKey(arweave, tx));
  await Promise.all(addKeysFuncs);

  txInfos.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
}

// Construct a string that will lexographically sort.
// { block_height, sha256(block_indep_hash + txid) }
// pad block height to 12 digits and convert hash value
// to a hex string.
async function addSortKey(arweave: Arweave, txInfo: any) {
  const { node } = txInfo;

  const blockHashBytes = arweave.utils.b64UrlToBuffer(node.block.id);
  const txIdBytes = arweave.utils.b64UrlToBuffer(node.id);
  const concatted = arweave.utils.concatBuffers([blockHashBytes, txIdBytes]);
  const hashed = arrayToHex(await arweave.crypto.hash(concatted));
  const blockHeight = `000000${node.block.height}`.slice(-12);

  txInfo.sortKey = `${blockHeight},${hashed}`;
}