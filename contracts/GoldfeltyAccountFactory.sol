// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

import {GoldfeltyAccount} from "./GoldfeltyAccount.sol";

/**
 * @title GoldfeltyAccountFactory
 * @notice Deploys GoldfeltyAccount clones at addresses that can be computed
 *         before the deployment happens.
 *
 * The app relies on this: a user can be handed a receiving address for a wallet
 * that does not exist on chain yet, accept funds at it, and have the contract
 * deployed later, on first send. That only holds because the address is a pure
 * function of (factory, owner, salt) — so the salt binds the owner in, and
 * nobody can deploy someone else's address out from under them.
 */
contract GoldfeltyAccountFactory {
    /// @notice The implementation every clone delegates to.
    GoldfeltyAccount public immutable accountImplementation;

    event AccountCreated(address indexed account, address indexed owner, uint256 salt);

    constructor() {
        accountImplementation = new GoldfeltyAccount();
    }

    /**
     * @notice Deploy the account for (owner, salt), or return it if it exists.
     * @dev Idempotent on purpose: the app may retry a first send after a dropped
     *      transaction, and a revert there would strand the user.
     */
    function createAccount(address owner, uint256 salt) external returns (GoldfeltyAccount account) {
        address predicted = getAddress(owner, salt);
        if (predicted.code.length > 0) {
            return GoldfeltyAccount(payable(predicted));
        }
        account = GoldfeltyAccount(payable(_clone(_salt(owner, salt))));
        account.initialize(owner);
        emit AccountCreated(address(account), owner, salt);
    }

    /// @notice The address `createAccount(owner, salt)` will produce.
    function getAddress(address owner, uint256 salt) public view returns (address) {
        return address(
            uint160(
                uint256(
                    keccak256(
                        abi.encodePacked(bytes1(0xff), address(this), _salt(owner, salt), keccak256(_initCode()))
                    )
                )
            )
        );
    }

    /// @dev Binding the owner into the salt is what stops address front-running.
    function _salt(address owner, uint256 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(owner, salt));
    }

    /// @dev ERC-1167 minimal proxy: 10 bytes of creation code, 45 of runtime.
    function _initCode() internal view returns (bytes memory) {
        return abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73",
            address(accountImplementation),
            hex"5af43d82803e903d91602b57fd5bf3"
        );
    }

    function _clone(bytes32 salt) internal returns (address instance) {
        bytes memory code = _initCode();
        assembly {
            instance := create2(0, add(code, 0x20), mload(code), salt)
        }
        require(instance != address(0), "create2 failed");
    }
}
