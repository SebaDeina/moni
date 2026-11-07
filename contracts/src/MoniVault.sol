// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Registro de atestaciones de KUMPLY (Fuji: 0xa3Bc5564A18e107807aF41fF2a5215Db050b22dD).
interface IAttestationStore {
    function verify(address subject)
        external
        view
        returns (bool verified, uint32 tier, uint64 timestamp, uint64 expiry);
}

/// @title MoniVault
/// @notice Bóveda de Moni, la billetera en WhatsApp. Cada usuario guarda AVAX o tokens ERC-20 (USDC)
///         y paga solo a contactos de su agenda, con un tope de gasto semanal que cumple el contrato,
///         no el backend: aunque el agente o el servidor se equivoquen, no sale más de lo permitido.
/// @dev Un solo contrato con cuentas por usuario. `msg.sender` es el usuario: sirve igual con una
///      wallet propia, una server wallet o una smart account (ERC-4337) con gas patrocinado.
contract MoniVault {
    /// @notice Representa a AVAX en los mapas indexados por token.
    address public constant NATIVE = address(0);

    /// @notice Las semanas empiezan el lunes 00:00 hora de Buenos Aires (UTC-3).
    ///         El 5 de enero de 1970 fue lunes: 4 días + 3 horas después del epoch, en UTC.
    uint256 public constant WEEK = 7 days;
    uint256 public constant WEEK_ORIGIN = 4 days + 3 hours;

    /// @notice Nivel mínimo de KUMPLY para considerar verificada a una persona (KYC estándar).
    uint32 public constant MIN_KYC_TIER = 2;

    /// @notice Registro de KUMPLY. Si es address(0), la verificación de destinatarios no está disponible.
    IAttestationStore public immutable kumply;

    mapping(address user => mapping(address token => uint256)) public balanceOf;
    /// @notice Tope semanal por token. 0 significa sin tope.
    mapping(address user => mapping(address token => uint256)) public weeklyLimit;
    mapping(address user => mapping(address token => mapping(uint256 week => uint256))) public spentInWeek;
    mapping(address user => mapping(address contact => bool)) public isContact;
    mapping(address user => bool) public requireVerifiedRecipients;

    uint256 private locked = 1;

    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event Paid(
        address indexed from, address indexed to, address indexed token, uint256 amount, uint256 week, string memo
    );
    event ContactSet(address indexed user, address indexed contact, bool allowed);
    event WeeklyLimitSet(address indexed user, address indexed token, uint256 limit);
    event VerifiedRecipientsRequired(address indexed user, bool required);

    error ZeroAmount();
    error ZeroAddress();
    error InsufficientBalance(uint256 available);
    error NotAContact(address to);
    error WeeklyLimitExceeded(uint256 remaining);
    error RecipientNotVerified(address to);
    error VerificationUnavailable();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (locked != 1) revert Reentrancy();
        locked = 2;
        _;
        locked = 1;
    }

    constructor(IAttestationStore kumply_) {
        kumply = kumply_;
    }

    // ------------------------------------------------------------------
    // Depósitos y retiros

    receive() external payable {
        _deposit(msg.sender, NATIVE, msg.value);
    }

    function depositNative() external payable {
        _deposit(msg.sender, NATIVE, msg.value);
    }

    /// @notice Requiere `approve` previo del token a este contrato.
    function deposit(address token, uint256 amount) external nonReentrant {
        if (token == NATIVE) revert ZeroAddress();
        _deposit(msg.sender, token, amount);
        _safeTransferFrom(token, msg.sender, address(this), amount);
    }

    /// @notice Retira a la propia wallet. No cuenta para el tope: la plata no sale del usuario.
    function withdraw(address token, uint256 amount) external nonReentrant {
        _debit(msg.sender, token, amount);
        emit Withdrawn(msg.sender, token, amount);
        _send(token, msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Pagos

    /// @notice Paga a un contacto de la agenda, dentro del tope semanal.
    function pay(address token, address to, uint256 amount, string calldata memo) external nonReentrant {
        if (!isContact[msg.sender][to]) revert NotAContact(to);
        if (requireVerifiedRecipients[msg.sender] && !isVerified(to)) revert RecipientNotVerified(to);

        uint256 week = currentWeek();
        uint256 limit = weeklyLimit[msg.sender][token];
        if (limit != 0) {
            uint256 spent = spentInWeek[msg.sender][token][week];
            uint256 remaining = spent >= limit ? 0 : limit - spent;
            if (amount > remaining) revert WeeklyLimitExceeded(remaining);
        }

        _debit(msg.sender, token, amount);
        spentInWeek[msg.sender][token][week] += amount;
        emit Paid(msg.sender, to, token, amount, week, memo);
        _send(token, to, amount);
    }

    // ------------------------------------------------------------------
    // Configuración del usuario

    function setContact(address contact, bool allowed) external {
        if (contact == address(0)) revert ZeroAddress();
        isContact[msg.sender][contact] = allowed;
        emit ContactSet(msg.sender, contact, allowed);
    }

    function setWeeklyLimit(address token, uint256 limit) external {
        weeklyLimit[msg.sender][token] = limit;
        emit WeeklyLimitSet(msg.sender, token, limit);
    }

    function setRequireVerifiedRecipients(bool required) external {
        if (required && address(kumply) == address(0)) revert VerificationUnavailable();
        requireVerifiedRecipients[msg.sender] = required;
        emit VerifiedRecipientsRequired(msg.sender, required);
    }

    // ------------------------------------------------------------------
    // Lecturas

    /// @notice Número de semana (lunes a domingo, hora de Buenos Aires) del bloque actual.
    function currentWeek() public view returns (uint256) {
        return (block.timestamp - WEEK_ORIGIN) / WEEK;
    }

    /// @notice Inicio (timestamp UTC) de una semana: lunes 00:00 hora de Buenos Aires.
    function weekStart(uint256 week) public pure returns (uint256) {
        return WEEK_ORIGIN + week * WEEK;
    }

    /// @notice Cuánto le queda por gastar esta semana. type(uint256).max si no tiene tope.
    function remainingThisWeek(address user, address token) external view returns (uint256) {
        uint256 limit = weeklyLimit[user][token];
        if (limit == 0) return type(uint256).max;
        uint256 spent = spentInWeek[user][token][currentWeek()];
        return spent >= limit ? 0 : limit - spent;
    }

    /// @notice Persona con KYC estándar en KUMPLY (atestación vigente y nivel 2 o 3).
    function isVerified(address subject) public view returns (bool) {
        if (address(kumply) == address(0)) return false;
        (bool verified, uint32 tier,,) = kumply.verify(subject);
        return verified && tier >= MIN_KYC_TIER && tier <= 3;
    }

    // ------------------------------------------------------------------
    // Internas

    function _deposit(address user, address token, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        balanceOf[user][token] += amount;
        emit Deposited(user, token, amount);
    }

    function _debit(address user, address token, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        uint256 available = balanceOf[user][token];
        if (amount > available) revert InsufficientBalance(available);
        balanceOf[user][token] = available - amount;
    }

    function _send(address token, address to, uint256 amount) private {
        if (token == NATIVE) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _callToken(token, abi.encodeCall(IERC20.transfer, (to, amount)));
        }
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        _callToken(token, abi.encodeCall(IERC20.transferFrom, (from, to, amount)));
    }

    /// @dev Acepta tokens que devuelven `true` y también los que no devuelven nada.
    function _callToken(address token, bytes memory data) private {
        if (token.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
