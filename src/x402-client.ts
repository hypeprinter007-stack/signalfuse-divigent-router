import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme, toClientEvmSigner } from "@x402/evm";
import type { ChainClients } from "./wallet.js";

export interface X402Stack {
  client: x402Client;
  http: x402HTTPClient;
  network: `eip155:${number}`;
}

export function createX402Stack(chain: ChainClients): X402Stack {
  const signer = toClientEvmSigner(
    {
      address: chain.account.address,
      signTypedData: (msg) => chain.account.signTypedData(msg as Parameters<typeof chain.account.signTypedData>[0]),
    },
    chain.publicClient,
  );

  const evmScheme = new ExactEvmScheme(signer);
  const network = `eip155:${chain.chainId}` as const;

  const client = new x402Client().register(network, evmScheme);
  const http = new x402HTTPClient(client);

  return { client, http, network };
}
