import { config } from '../config.js';
import { t } from '../core/i18n.js';
import { enableNotifications, notificationPermission } from '../core/push.js';
import { playMessageAlert } from '../core/notification-sound.js';
import { api } from '../core/net.js';
import { inbox } from '../data/chats.js';
import { Sheet } from './sheet.js';
import { h, ago, toast } from './dom.js';

export class NotificationsView {
  constructor({ onOpenLive, onOpenMessage } = {}) {
    this.onOpenLive = onOpenLive;
    this.onOpenMessage = onOpenMessage;
    this.onUnread = null;
    this.rooms = [];
    this.alerts = [];
    this.sheet = new Sheet({ title: t('notifications'), className: 'notifications-sheet', autoFocus: false });
    this.body = h('div', { class: 'stack notifications-list' });
    this.sheet.body.append(this.body);
    inbox.subscribe(rooms => this.#paintUnread(rooms));
  }

  open() {
    this.sheet.open();
    inbox.refresh();
    void this.#load();
  }

  preload() {
    inbox.refresh();
    void this.#load();
  }

  #paintUnread(rooms = []) {
    this.rooms = rooms || [];
    const messages = this.rooms.filter(room => room.unread).length;
    this.unreadMessages = messages;
    this.onUnread?.(messages + (this.unreadAlerts || 0));
    this.#render();
  }

  async #load() {
    this.loaded = false;
    this.body.replaceChildren(h('p', { class: 'muted center' }, t('loading')));
    const permissionRow = h('button', {
      class: 'nova-row',
      type: 'button',
      onclick: async () => {
        permissionRow.disabled = true;
        try {
          const permission = await enableNotifications();
          permissionRow.querySelector('.nova-row-detail').textContent = t(`notificationPermission_${permission}`);
        } catch (error) {
          permissionRow.querySelector('.nova-row-detail').textContent = error?.message || t('notificationSetupFailed');
          console.warn('[notifications] Permission setup failed.', error);
        } finally {
          permissionRow.disabled = false;
        }
      },
    },
    h('span', { class: 'nova-row-icon', 'aria-hidden': 'true' }, '🔔'),
    h('span', { class: 'nova-row-label' }, t('enableNotifications')),
    h('small', { class: 'muted nova-row-detail' }, t('loading')));
    const testSound = h('button', {
      class: 'nova-row',
      type: 'button',
      onclick: async () => {
        const played = await playMessageAlert();
        toast(played ? t('messageSoundTested') : t('soundTestBlocked'));
      },
    },
    h('span', { class: 'nova-row-icon', 'aria-hidden': 'true' }, '🔊'),
    h('span', { class: 'nova-row-label' }, t('testMessageSound')),
    h('small', { class: 'muted nova-row-detail' }, t('soundTestHint')));
    try {
      permissionRow.querySelector('.nova-row-detail').textContent = t(`notificationPermission_${await notificationPermission()}`);
    } catch (error) {
      permissionRow.querySelector('.nova-row-detail').textContent = error?.message || t('notificationSetupFailed');
      console.warn('[notifications] Permission status could not be read.', error);
    }

    let alerts = [];
    try {
      const result = await api(`${config.api.base}/milkyway-notifications?action=alerts`, { timeout: 10000 });
      alerts = Array.isArray(result?.alerts) ? result.alerts : [];
      this.unreadAlerts = Number(result?.unread) || 0;
      this.onUnread?.(this.unreadMessages + this.unreadAlerts);
    } catch (error) {
      this.body.replaceChildren(permissionRow, testSound, h('p', { class: 'muted center', role: 'status' }, error?.message || t('retry')));
      return;
    }

    this.permissionRow = permissionRow;
    this.testSound = testSound;
    this.alerts = alerts;
    this.loaded = true;
    this.#render();
  }

  #render() {
    if (!this.loaded) return;
    const messages = this.rooms.filter(room => room.unread).map(room => h('button', {
      class: 'nova-row notification-item unread',
      type: 'button',
      onclick: () => {
        this.sheet.close();
        this.onOpenMessage?.(room.peer);
      },
    },
    h('span', { class: 'nova-row-icon', 'aria-hidden': 'true' }, '✉'),
    h('span', { class: 'nova-row-label' }, room.name || 'MilkyWay'),
    h('small', { class: 'muted nova-row-detail' }, room.preview || t('inbox'))));
    const alerts = this.alerts.map(alert => h('button', {
      class: `nova-row notification-item${alert.read ? '' : ' unread'}`,
      type: 'button',
      onclick: () => {
        this.sheet.close();
        if (!alert.read) {
          api(`${config.api.base}/milkyway-notifications?action=read`, {
            method: 'POST', body: { rooms: [alert.room] }, timeout: 10000,
          }).catch(error => console.warn('[notifications] Could not mark alert as read.', error));
        }
        this.onOpenLive?.(alert.room);
      },
    },
    h('span', { class: 'nova-row-icon', 'aria-hidden': 'true' }, '🔴'),
    h('span', { class: 'nova-row-label' }, alert.title || `${alert.hostName || 'MilkyWay'} · ${t('live')}`),
    h('small', { class: 'muted nova-row-detail' }, ago(alert.createdAt))));
    const rows = [
      this.permissionRow,
      this.testSound,
      ...(messages.length ? [h('p', { class: 'nova-section' }, t('inbox')), ...messages] : []),
      h('p', { class: 'nova-section' }, t('recentNotifications')),
      ...(alerts.length ? alerts : messages.length ? [] : [h('p', { class: 'muted center', role: 'status' }, t('noNotifications'))]),
    ];
    this.body.replaceChildren(...rows);
  }
}
