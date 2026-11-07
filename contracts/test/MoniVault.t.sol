// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MoniVault, IAttestationStore} from "../src/MoniVault.sol";

contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract MockKumply is IAttestationStore {
    mapping(address => uint32) public tierOf;

    function set(address subject, uint32 tier) external {
        tierOf[subject] = tier;
    }

    function verify(address subject) external view returns (bool, uint32, uint64, uint64) {
        uint32 tier = tierOf[subject];
        return (tier > 0, tier, 0, 0);
    }
}

contract MoniVaultTest is Test {
    MoniVault vault;
    MockUSDC usdc;
    MockKumply kumply;

    address user = makeAddr("user");
    address juan = makeAddr("juan");
    address extrano = makeAddr("extrano");
    address constant AVAX = address(0);

    // Miércoles 4/11/2026 15:00 hora de Buenos Aires (18:00 UTC).
    uint256 constant WEDNESDAY = 1793815200;

    function setUp() public {
        vm.warp(WEDNESDAY);
        usdc = new MockUSDC();
        kumply = new MockKumply();
        vault = new MoniVault(kumply);

        vm.deal(user, 10 ether);
        usdc.mint(user, 1_000e6);

        vm.startPrank(user);
        vault.depositNative{value: 5 ether}();
        usdc.approve(address(vault), 500e6);
        vault.deposit(address(usdc), 500e6);
        vault.setContact(juan, true);
        vm.stopPrank();
    }

    function test_DepositsAreCredited() public view {
        assertEq(vault.balanceOf(user, AVAX), 5 ether);
        assertEq(vault.balanceOf(user, address(usdc)), 500e6);
        assertEq(address(vault).balance, 5 ether);
        assertEq(usdc.balanceOf(address(vault)), 500e6);
    }

    function test_PayContactInAvaxAndUsdc() public {
        vm.startPrank(user);
        vault.pay(AVAX, juan, 1 ether, "asado");
        vault.pay(address(usdc), juan, 25e6, "almuerzo");
        vm.stopPrank();

        assertEq(juan.balance, 1 ether);
        assertEq(usdc.balanceOf(juan), 25e6);
        assertEq(vault.balanceOf(user, AVAX), 4 ether);
        assertEq(vault.balanceOf(user, address(usdc)), 475e6);
    }

    function test_EmitsPaidWithMemo() public {
        vm.expectEmit(address(vault));
        emit MoniVault.Paid(user, juan, address(usdc), 10e6, vault.currentWeek(), "cafe");
        vm.prank(user);
        vault.pay(address(usdc), juan, 10e6, "cafe");
    }

    function test_RevertWhen_NotAContact() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MoniVault.NotAContact.selector, extrano));
        vault.pay(AVAX, extrano, 1 ether, "");
    }

    function test_RevertWhen_ContactRemoved() public {
        vm.startPrank(user);
        vault.setContact(juan, false);
        vm.expectRevert(abi.encodeWithSelector(MoniVault.NotAContact.selector, juan));
        vault.pay(AVAX, juan, 1 ether, "");
        vm.stopPrank();
    }

    function test_RevertWhen_InsufficientBalance() public {
        vm.prank(user);
        vm.expectRevert(abi.encodeWithSelector(MoniVault.InsufficientBalance.selector, 500e6));
        vault.pay(address(usdc), juan, 501e6, "");
    }

    function test_RevertWhen_ZeroAmount() public {
        vm.prank(user);
        vm.expectRevert(MoniVault.ZeroAmount.selector);
        vault.pay(AVAX, juan, 0, "");
    }

    function test_WeeklyLimit() public {
        vm.startPrank(user);
        vault.setWeeklyLimit(address(usdc), 100e6);
        vault.pay(address(usdc), juan, 60e6, "");
        assertEq(vault.remainingThisWeek(user, address(usdc)), 40e6);

        vm.expectRevert(abi.encodeWithSelector(MoniVault.WeeklyLimitExceeded.selector, 40e6));
        vault.pay(address(usdc), juan, 41e6, "");

        vault.pay(address(usdc), juan, 40e6, "");
        assertEq(vault.remainingThisWeek(user, address(usdc)), 0);

        // El tope es por token: AVAX no tiene tope.
        vault.pay(AVAX, juan, 3 ether, "");
        vm.stopPrank();
    }

    function test_WeeklyLimitResetsMondayMidnightBuenosAires() public {
        vm.startPrank(user);
        vault.setWeeklyLimit(address(usdc), 100e6);
        vault.pay(address(usdc), juan, 100e6, "");

        // Domingo 8/11 23:59:59 BA = lunes 9/11 02:59:59 UTC: sigue siendo la misma semana.
        vm.warp(1794193199);
        vm.expectRevert(abi.encodeWithSelector(MoniVault.WeeklyLimitExceeded.selector, 0));
        vault.pay(address(usdc), juan, 1e6, "");

        // Lunes 9/11 00:00 BA = 03:00 UTC: semana nueva.
        vm.warp(1794193200);
        assertEq(vault.weekStart(vault.currentWeek()), 1794193200);
        vault.pay(address(usdc), juan, 100e6, "");
        vm.stopPrank();
    }

    function test_WithdrawIsNotLimited() public {
        vm.startPrank(user);
        vault.setWeeklyLimit(AVAX, 1 ether);
        vault.withdraw(AVAX, 5 ether);
        vm.stopPrank();
        assertEq(user.balance, 10 ether);
        assertEq(vault.balanceOf(user, AVAX), 0);
    }

    function test_UsersAreIsolated() public {
        vm.prank(juan);
        vm.expectRevert(abi.encodeWithSelector(MoniVault.NotAContact.selector, user));
        vault.pay(AVAX, user, 1 ether, "");

        vm.prank(juan);
        vm.expectRevert(abi.encodeWithSelector(MoniVault.InsufficientBalance.selector, 0));
        vault.withdraw(AVAX, 1 ether);
    }

    function test_KumplyGate() public {
        address verificada = makeAddr("verificada");
        address empresa = makeAddr("empresa");
        kumply.set(verificada, 2);
        kumply.set(empresa, 4); // KYB: no es persona

        vm.startPrank(user);
        vault.setContact(verificada, true);
        vault.setContact(empresa, true);
        vault.setRequireVerifiedRecipients(true);

        vault.pay(AVAX, verificada, 1 ether, "ok");

        vm.expectRevert(abi.encodeWithSelector(MoniVault.RecipientNotVerified.selector, juan));
        vault.pay(AVAX, juan, 1 ether, "");

        vm.expectRevert(abi.encodeWithSelector(MoniVault.RecipientNotVerified.selector, empresa));
        vault.pay(AVAX, empresa, 1 ether, "");
        vm.stopPrank();
    }

    function test_RevertWhen_KumplyMissing() public {
        MoniVault sinKumply = new MoniVault(IAttestationStore(address(0)));
        vm.expectRevert(MoniVault.VerificationUnavailable.selector);
        sinKumply.setRequireVerifiedRecipients(true);
    }

    function test_DirectAvaxTransferIsDeposit() public {
        vm.prank(user);
        (bool ok,) = address(vault).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(vault.balanceOf(user, AVAX), 6 ether);
    }
}
