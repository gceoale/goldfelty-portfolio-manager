// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/**
 * @title GoldfeltyAccount
 * @notice A minimal owner-controlled smart-contract account.
 *
 * Every wallet in Goldfelty Portfolio Manager is a clone of this contract. The
 * account holds the funds; a single owner key — derived from the user's
 * recovery phrase at a BIP-44 index — authorises what it does. That indirection
 * is what makes "connect a wallet" mean something beyond "paste a key":
 * ownership can rotate, calls can be batched, and the address is fixed by
 * CREATE2 before the contract is ever deployed.
 *
 * Clones are deployed by GoldfeltyAccountFactory and initialised exactly once.
 */
contract GoldfeltyAccount {
    /// @notice The key permitted to act for this account.
    address public owner;

    /// @notice Monotonic counter, so an authorisation cannot be replayed.
    uint256 public nonce;

    /// @dev ERC-1271 magic value for a valid signature.
    bytes4 private constant ERC1271_MAGIC = 0x1626ba7e;

    event GoldfeltyAccountInitialized(address indexed owner);
    event OwnerChanged(address indexed previousOwner, address indexed newOwner);
    event Executed(address indexed target, uint256 value, bytes data);
    event Received(address indexed from, uint256 value);

    error AlreadyInitialized();
    error NotOwner();
    error ZeroAddress();
    error LengthMismatch();
    error CallFailed(uint256 index, bytes reason);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /**
     * @notice Set the account's owner. Callable once, by the factory, at deploy.
     * @dev The clone's storage starts zeroed, so a non-zero owner means this has
     *      already run — that check is the whole guard against a hijack.
     */
    function initialize(address anOwner) external {
        if (owner != address(0)) revert AlreadyInitialized();
        if (anOwner == address(0)) revert ZeroAddress();
        owner = anOwner;
        emit GoldfeltyAccountInitialized(anOwner);
    }

    /// @notice Perform one call as this account.
    function execute(address dest, uint256 value, bytes calldata func)
        external
        onlyOwner
        returns (bytes memory result)
    {
        unchecked {
            ++nonce;
        }
        bool success;
        (success, result) = dest.call{value: value}(func);
        if (!success) revert CallFailed(0, result);
        emit Executed(dest, value, func);
    }

    /**
     * @notice Perform several calls atomically.
     * @dev Used to deploy-and-send in one transaction, and to approve-then-swap
     *      without leaving a dangling allowance between two transactions.
     */
    function executeBatch(address[] calldata dest, uint256[] calldata value, bytes[] calldata func)
        external
        onlyOwner
    {
        if (dest.length != value.length || dest.length != func.length) revert LengthMismatch();
        unchecked {
            ++nonce;
        }
        for (uint256 i = 0; i < dest.length; ++i) {
            (bool success, bytes memory reason) = dest[i].call{value: value[i]}(func[i]);
            if (!success) revert CallFailed(i, reason);
            emit Executed(dest[i], value[i], func[i]);
        }
    }

    /// @notice Hand the account to a new owner. Irreversible — check twice.
    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerChanged(owner, newOwner);
        owner = newOwner;
    }

    /// @notice ERC-1271: is this signature valid for this account?
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (signature.length != 65) return 0xffffffff;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        // Reject the upper half of the curve order: otherwise every signature
        // has a second, equally valid form, and anything keyed on the signature
        // bytes can be bypassed.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            return 0xffffffff;
        }
        if (v != 27 && v != 28) return 0xffffffff;

        address recovered = ecrecover(hash, v, r, s);
        if (recovered != address(0) && recovered == owner) return ERC1271_MAGIC;
        return 0xffffffff;
    }

    receive() external payable {
        emit Received(msg.sender, msg.value);
    }
}
