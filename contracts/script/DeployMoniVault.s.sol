// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MoniVault, IAttestationStore} from "../src/MoniVault.sol";

/// forge script script/DeployMoniVault.s.sol --rpc-url fuji --private-key $DEPLOYER_KEY --broadcast --verify
contract DeployMoniVault is Script {
    /// AttestationStore de KUMPLY en Fuji.
    IAttestationStore constant KUMPLY_FUJI = IAttestationStore(0xa3Bc5564A18e107807aF41fF2a5215Db050b22dD);

    function run() external returns (MoniVault vault) {
        require(block.chainid == 43113, "Solo Fuji");
        vm.startBroadcast();
        vault = new MoniVault(KUMPLY_FUJI);
        vm.stopBroadcast();
        console.log("MoniVault:", address(vault));
    }
}
