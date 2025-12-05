pragma solidity ^0.8.24;

import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";


contract GamerIDFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error CooldownActive();
    error BatchClosed();
    error InvalidBatchId();
    error ReplayDetected();
    error StateMismatch();
    error InvalidDecryptionProof();
    error NotInitialized();
    error InvalidParameter();

    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event PausedContract(address indexed account);
    event UnpausedContract(address indexed account);
    event CooldownSecondsSet(uint256 oldCooldownSeconds, uint256 newCooldownSeconds);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event GameDataSubmitted(address indexed provider, uint256 indexed batchId, uint256 gameId, address indexed playerAddress);
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId, address indexed playerAddress, uint256 gameId, uint256 achievementId);
    event DecryptionCompleted(uint256 indexed requestId, uint256 indexed batchId, address indexed playerAddress, uint256 gameId, uint256 achievementId, bool hasAchievement);

    struct DecryptionContext {
        uint256 batchId;
        address playerAddress;
        uint256 gameId;
        uint256 achievementId;
        bytes32 stateHash;
        bool processed;
    }

    struct PlayerGameInfo {
        euint32 gameIdEnc;
        euint32 achievementIdEnc;
        ebool hasAchievementEnc;
    }

    address public owner;
    mapping(address => bool) public isProvider;
    bool public paused;
    uint256 public cooldownSeconds;
    mapping(address => uint256) public lastSubmissionTime;
    mapping(address => uint256) public lastDecryptionRequestTime;

    uint256 public currentBatchId;
    mapping(uint256 => bool) public isBatchOpen;
    mapping(uint256 => mapping(address => mapping(uint256 => PlayerGameInfo))) public playerData; // batchId => playerAddress => gameId => PlayerGameInfo

    mapping(uint256 => DecryptionContext) public decryptionContexts;

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!isProvider[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier respectCooldown(address _address, mapping(address => uint256) storage _lastActionTime) {
        if (block.timestamp < _lastActionTime[_address] + cooldownSeconds) {
            revert CooldownActive();
        }
        _;
    }

    constructor() {
        owner = msg.sender;
        isProvider[owner] = true;
        emit ProviderAdded(owner);
        cooldownSeconds = 30; // Default cooldown
    }

    function addProvider(address _provider) external onlyOwner {
        if (!isProvider[_provider]) {
            isProvider[_provider] = true;
            emit ProviderAdded(_provider);
        }
    }

    function removeProvider(address _provider) external onlyOwner {
        if (isProvider[_provider]) {
            isProvider[_provider] = false;
            emit ProviderRemoved(_provider);
        }
    }

    function setPause(bool _paused) external onlyOwner {
        paused = _paused;
        if (_paused) {
            emit PausedContract(msg.sender);
        } else {
            emit UnpausedContract(msg.sender);
        }
    }

    function setCooldownSeconds(uint256 _cooldownSeconds) external onlyOwner {
        if (_cooldownSeconds == 0) revert InvalidParameter();
        emit CooldownSecondsSet(cooldownSeconds, _cooldownSeconds);
        cooldownSeconds = _cooldownSeconds;
    }

    function openBatch() external onlyOwner whenNotPaused {
        currentBatchId++;
        isBatchOpen[currentBatchId] = true;
        emit BatchOpened(currentBatchId);
    }

    function closeBatch(uint256 _batchId) external onlyOwner {
        if (!isBatchOpen[_batchId]) revert InvalidBatchId();
        isBatchOpen[_batchId] = false;
        emit BatchClosed(_batchId);
    }

    function submitGameData(
        uint256 _batchId,
        address _playerAddress,
        uint256 _gameId,
        uint256 _achievementId,
        ebool memory _hasAchievementEnc
    ) external onlyProvider whenNotPaused respectCooldown(msg.sender, lastSubmissionTime) {
        if (!isBatchOpen[_batchId]) revert BatchClosed();

        PlayerGameInfo storage info = playerData[_batchId][_playerAddress][_gameId];
        info.gameIdEnc = FHE.asEuint32(_gameId);
        info.achievementIdEnc = FHE.asEuint32(_achievementId);
        info.hasAchievementEnc = _hasAchievementEnc;

        lastSubmissionTime[msg.sender] = block.timestamp;
        emit GameDataSubmitted(msg.sender, _batchId, _gameId, _playerAddress);
    }

    function checkAchievement(
        uint256 _batchId,
        address _playerAddress,
        uint256 _gameId,
        uint256 _achievementId
    ) external whenNotPaused respectCooldown(msg.sender, lastDecryptionRequestTime) {
        if (!isBatchOpen[_batchId]) revert BatchClosed();
        PlayerGameInfo storage info = playerData[_batchId][_playerAddress][_gameId];
        _requireInitialized(info.hasAchievementEnc);
        _requireInitialized(info.achievementIdEnc);

        ebool memory achievementMatch = info.achievementIdEnc.eq(FHE.asEuint32(_achievementId));

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(achievementMatch);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.myCallback.selector);

        decryptionContexts[requestId] = DecryptionContext({
            batchId: _batchId,
            playerAddress: _playerAddress,
            gameId: _gameId,
            achievementId: _achievementId,
            stateHash: stateHash,
            processed: false
        });

        lastDecryptionRequestTime[msg.sender] = block.timestamp;
        emit DecryptionRequested(requestId, _batchId, _playerAddress, _gameId, _achievementId);
    }

    function myCallback(uint256 requestId, bytes memory cleartexts, bytes memory proof) public {
        if (decryptionContexts[requestId].processed) revert ReplayDetected();

        DecryptionContext storage ctx = decryptionContexts[requestId];

        // Rebuild ciphertexts in the exact same order as during requestDecryption
        PlayerGameInfo storage info = playerData[ctx.batchId][ctx.playerAddress][ctx.gameId];
        ebool memory achievementMatch = info.achievementIdEnc.eq(FHE.asEuint32(ctx.achievementId));
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(achievementMatch);

        bytes32 currentHash = _hashCiphertexts(cts);
        if (currentHash != ctx.stateHash) revert StateMismatch();

        if (!FHE.checkSignatures(requestId, cleartexts, proof)) revert InvalidDecryptionProof();

        bool hasAchievement = abi.decode(cleartexts, (bool));
        ctx.processed = true;

        emit DecryptionCompleted(requestId, ctx.batchId, ctx.playerAddress, ctx.gameId, ctx.achievementId, hasAchievement);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal view returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 storage x, uint32 val) internal {
        if (!FHE.isInitialized(x)) {
            x = FHE.asEuint32(val);
        }
    }

    function _requireInitialized(euint32 storage x) internal view {
        if (!FHE.isInitialized(x)) revert NotInitialized();
    }

    function _requireInitialized(ebool storage x) internal view {
        if (!FHE.isInitialized(x)) revert NotInitialized();
    }
}